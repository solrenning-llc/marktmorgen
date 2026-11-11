import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { speech } from "@/lib/buyer-words";
import { orderProblemWords } from "@/lib/buyer-words/order-problem";
import { type Purchase, OrdersBusy, OrdersLate, findPurchase, openOrders, purchasesFor, withinOpening } from "@/lib/buyer-orders";
import { OrderProblemForm } from "@/components/order-problem-form";

// The longest one opening may run: findPurchase is bounded by DOWNLOAD_LOOKUP_MS.
export const maxDuration = 30;

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Pick<Params, "params">): Promise<Metadata> {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return { title: `${orderProblemWords(store?.language).title} — Marktmorgen`, robots: { index: false, follow: false } };
}

/** What the route answered (app/api/store/order-problem), as the page says it. */
const STATES = ["filed", "already", "busy", "limited", "full", "error", "reason", "note", "order"] as const;
type State = (typeof STATES)[number];

/**
 * "Report a problem with this order" (567 [GD1] (a), unit 3), reached from
 * the one link under the buyer's list of purchases. With no order chosen, it
 * lists the orders of the link's address, read and paid for exactly as an
 * opening of the list is; with one chosen, the order must be one that address
 * paid for (findPurchase), and the form sends the report to the creator's
 * inbox (app/api/store/order-problem). What the route answered is said in a
 * status region; a sent or already open report shows no form.
 */
export default async function ProblemPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const said = speech(store);
  const w = orderProblemWords(store.language);
  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token : "";
  const reference = typeof query.ref === "string" ? query.ref : "";
  const state: State | "" = typeof query.problem === "string" && (STATES as readonly string[]).includes(query.problem) ? (query.problem as State) : "";
  const back = `/@${store.handle}/orders?${new URLSearchParams({ token })}`;

  let found: Awaited<ReturnType<typeof findPurchase>> = null;
  let trouble: "busy" | "error" | "" = "";
  let choices: Purchase[] | null = null;
  if (!reference) {
    try {
      const opened = await openOrders(store, token);
      if (!opened.admitted) trouble = "busy";
      else if (opened.email) {
        const read = await withinOpening(purchasesFor(store, opened.email, opened.meter), opened.meter);
        if (read === "late") trouble = "busy";
        else choices = read;
      }
    } catch (error) {
      trouble = error instanceof OrdersBusy || error instanceof OrdersLate ? "busy" : "error";
    }
  } else {
    try {
      found = await findPurchase(store, token, reference);
    } catch (error) {
      trouble = error instanceof OrdersBusy || error instanceof OrdersLate ? "busy" : "error";
    }
  }

  const sentences: Record<State, string> = {
    filed: w.sent(store.name),
    already: w.alreadyOpen,
    busy: w.busyNow,
    limited: w.errorLimited,
    full: w.storeFull,
    error: w.errorUnavailable,
    reason: w.errorReason,
    note: w.errorNote,
    order: w.errorOrder,
  };
  const notice = state
    ? sentences[state]
    : trouble === "busy"
      ? w.busyNow
      : trouble === "error"
        ? w.errorUnavailable
        : !found && !choices
          ? w.errorOrder
          : "";
  const done = state === "filed" || state === "already";
  const showForm = Boolean(found && !trouble && !done);

  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <p className="st-muted text-center text-sm font-semibold">{store.name}</p>
        <div className="st-card mt-6 p-6 sm:p-9">
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{w.title}</h1>
          <div role="status" className={notice ? "st-note mt-5" : undefined}>
            {notice ? <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice}</p> : null}
          </div>
          {choices ? (
            choices.length ? (
              <>
                <p className="st-muted mt-4 leading-relaxed">{w.chooseLead}</p>
                <ul className="mt-3 space-y-2">
                  {choices.map((purchase) => (
                    <li key={purchase.reference} className="[overflow-wrap:anywhere]">
                      <Link href={`/@${store.handle}/orders/problem?${new URLSearchParams({ token, ref: purchase.reference })}`} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
                        {purchase.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="st-muted mt-4">{w.none}</p>
            )
          ) : null}
          {found ? (
            <>
              <p className="st-muted mt-4 leading-relaxed">{w.intro}</p>
              <dl className="mt-4 space-y-2 text-sm">
                <div>
                  <dt className="font-semibold">{w.productLabel}</dt>
                  <dd className="[overflow-wrap:anywhere]">{found.purchase.title}</dd>
                </div>
                <div>
                  <dt className="font-semibold">{w.orderLabel}</dt>
                  <dd className="[overflow-wrap:anywhere]">{found.purchase.reference}</dd>
                </div>
              </dl>
            </>
          ) : null}
          {showForm && found ? <OrderProblemForm handle={store.handle} token={token} reference={found.purchase.reference} language={store.language} /> : null}
          <p className="mt-8">
            <Link href={back} className="st-footer-link inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
              {w.backToList}
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
