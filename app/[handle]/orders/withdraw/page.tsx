import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmailField } from "@/components/email-field";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { speech } from "@/lib/buyer-words";
import { withdrawalWords } from "@/lib/buyer-words/withdrawal";
import { type Purchase, OrdersBusy, OrdersLate, findPurchase, openOrders, purchasesFor, withinOpening } from "@/lib/buyer-orders";
import { type WithdrawalOwed, windowOf, withConfirmations, withdrawalReference, withdrawalStanding } from "@/lib/withdrawal";
import { lastWithdrawalDay } from "@/lib/withdrawal-rules";

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
  return { title: `${withdrawalWords(store?.language).title} — Marktmorgen`, robots: { index: false, follow: false } };
}

/**
 * The EU withdrawal function's statement (Directive 2011/83/EU art. 11a;
 * lib/withdrawal.ts, 588 [KB9]), reached from "Withdraw from contract here"
 * on the buyer's list of purchases. The order must be one the link's address
 * paid for, read again from Stripe; the name and the email for the
 * confirmation are typed or confirmed here (the email filled in from the
 * link's address, editable), and "Confirm withdrawal" sends it. Shown only
 * while the period runs; afterwards, or once withdrawn, it says so.
 */
export default async function WithdrawPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const said = speech(store);
  const w = withdrawalWords(store.language);
  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token : "";
  const reference = typeof query.ref === "string" ? query.ref : "";
  const state = typeof query.w === "string" && Object.hasOwn(w.notices, query.w) ? query.w : "";
  const back = `/@${store.handle}/orders?${new URLSearchParams({ token })}`;

  let found: Awaited<ReturnType<typeof findPurchase>> = null;
  let trouble: "busy" | "error" | "" = "";
  // Opened from the list's one link, with no order chosen yet: the purchases still inside their period, read and paid for
  // exactly as an opening of the list is (openOrders takes ORDERS_OPEN_UNITS before anything is read).
  let choices: Purchase[] | null = null;
  if (!reference) {
    try {
      const opened = await openOrders(store, token);
      if (!opened.admitted) trouble = "busy";
      else if (opened.email) {
        // Each order's confirmation mark, where the yes would end the right, read through the same meter (withConfirmations).
        const meter = opened.meter;
        const read = await withinOpening(purchasesFor(store, opened.email, meter).then((listed) => withConfirmations(listed, meter)), meter);
        if (read === "late") trouble = "busy";
        else choices = read.filter((purchase) => windowOf(purchase).open);
      }
    } catch (error) {
      trouble = error instanceof OrdersBusy || error instanceof OrdersLate ? "busy" : "error";
    }
  } else {
    try {
      found = await findPurchase(store, token, reference);
      // Whether its confirmation is known sent, where the yes would end the right, read through the lookup's meter.
      if (found) found = { ...found, purchase: (await withConfirmations([found.purchase], found.meter))[0] };
    } catch (error) {
      trouble = error instanceof OrdersBusy || error instanceof OrdersLate ? "busy" : "error";
    }
  }
  let already = false;
  // A recorded withdrawal whose acknowledgement or creator's notice is still owed offers the form again, so sending it
  // once more tries what is owed (lib/withdrawal.ts); its first time stands.
  let owed: WithdrawalOwed | null = null;
  if (found) {
    try {
      const standing = await withdrawalStanding(store, withdrawalReference(found.purchase));
      owed = standing.owed;
      already = standing.at !== null && owed === null;
    } catch {
      trouble = "error";
    }
  }
  const window = found ? windowOf(found.purchase) : null;
  const notice = state
    ? w.notices[state]
    : trouble
      ? w.notices[trouble]
      : choices
        ? null
        : owed
          ? w.notices[owed]
          : already
          ? w.notices.already
          : found && window && !window.open
            ? w.notices.closed
            : !found
              ? w.notices.closed
              : null;
  // Owed means recorded in time already: the form is offered again whatever the period says now.
  const showForm = Boolean(found && (owed || (window?.open && !already)) && !trouble && state !== "done" && state !== "already");
  // The last day of the period, the one it is still open to the end of (lib/withdrawal-rules.ts, withdrawalEnd): its own calendar day, never the UTC day of its last instant.
  const until = window?.open && window.until !== null ? new Intl.DateTimeFormat(said.lang.locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(lastWithdrawalDay(window.until) * 1000)) : null;

  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <p className="st-muted text-center text-sm font-semibold">{store.name}</p>
        <div className="st-card mt-6 p-6 sm:p-9">
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{w.title}</h1>
          {notice ? (
            <div className="st-note mt-5" role="status">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
              <p className="mt-1 text-sm">{notice.body}</p>
            </div>
          ) : null}
          {choices ? (
            choices.length ? (
              <>
                <p className="st-muted mt-4 leading-relaxed">{w.chooseLead}</p>
                <ul className="mt-3 space-y-2">
                  {choices.map((purchase) => (
                    <li key={purchase.reference} className="[overflow-wrap:anywhere]">
                      <Link href={`/@${store.handle}/orders/withdraw?${new URLSearchParams({ token, ref: purchase.reference })}`} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
                        {purchase.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="st-muted mt-4">{w.noneOpen}</p>
            )
          ) : null}
          {showForm && found ? (
            <form action="/api/store/withdraw" method="post" className="mt-6 space-y-4">
              <p className="st-muted leading-relaxed">{w.lead(found.purchase.title, store.name)}</p>
              {until ? <p className="text-sm">{w.until(until)}</p> : null}
              <input type="hidden" name="handle" value={store.handle} />
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="ref" value={found.purchase.reference} />
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="font-semibold">{w.productLabel}</dt>
                  <dd className="[overflow-wrap:anywhere]">{found.purchase.title}</dd>
                </div>
                <div>
                  <dt className="font-semibold">{w.orderLabel}</dt>
                  <dd className="[overflow-wrap:anywhere]">{found.purchase.reference}</dd>
                </div>
              </dl>
              <div>
                <label htmlFor="withdraw-name" className="st-label">{w.nameLabel}</label>
                <input id="withdraw-name" name="name" type="text" required maxLength={200} autoComplete="name" className="st-field" />
              </div>
              <div>
                <label htmlFor="withdraw-email" className="st-label">{w.emailLabel}</label>
                <EmailField id="withdraw-email" name="email" className="st-field" required autoComplete="email" defaultValue={found.email} describedBy="withdraw-email-hint" language={store.language} />
                <p id="withdraw-email-hint" className="st-muted mt-1 text-sm">{w.emailHint}</p>
              </div>
              <button type="submit" className="btn st-btn btn-block">{w.confirm}</button>
              <p className="st-muted text-sm">{w.after(store.name)}</p>
            </form>
          ) : null}
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
