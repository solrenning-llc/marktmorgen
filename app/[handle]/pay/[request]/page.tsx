import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { speechFor } from "@/lib/buyer-words";
import { requestWords } from "@/lib/buyer-words/requests";
import { withinStore } from "@/lib/metered-limits";
import { clientAddress } from "@/lib/request-guard";
import { sellsInTestMode } from "@/lib/stripe-connect";
import { SITE_URL } from "@/lib/site-url";
import { ID_PATTERN, statusOf } from "@/lib/payment-request-rules";
import { requestOf } from "@/lib/payment-request-store";
import { requestsOpen, settleFromReturn } from "@/lib/payment-requests";
import { confirmPurchase } from "@/lib/purchase-email";
import { PrintButton } from "@/components/print-button";
import { StoreResting } from "@/components/store-resting";

type Params = {
  params: Promise<{ handle: string; request: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** A request's link is a private address: never indexed, never followed. */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return { title: `${requestWords(store?.language).pageTitle}${store ? ` — ${store.name}` : ""}`, robots: { index: false, follow: false } };
}

/** How many times one connection may open request pages of one store in ten minutes. */
const VIEWS_PER_TEN_MINUTES = 60;

/**
 * One payment request, as its buyer sees it (lib/payment-request-rules.ts):
 * who is asking, for what, how much, by when, and one button to Stripe's
 * page on the creator's own account. Back from paying, it confirms the
 * payment once (lib/purchase-email.ts) and becomes the receipt, which can
 * be printed. It says plainly that nothing is charged unless they pay, and
 * where to report a request they do not recognize.
 */
export default async function PaymentRequestPage({ params, searchParams }: Params) {
  const { handle: raw, request: id } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@") || !ID_PATTERN.test(id)) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  // One of the store's buyer requests, counted in its window (lib/traffic.ts).
  const allowed = await withinStore("pay-request-view", `${clientAddress({ headers: await headers() })}|${store.handle}`, VIEWS_PER_TEN_MINUTES, 600, store, "buyer");
  if (!allowed) return <StoreResting store={store} />;
  let request = await requestOf(store, id);
  if (!request) notFound();
  const query = await searchParams;
  const sessionId = typeof query.session_id === "string" ? query.session_id : "";
  if (sessionId) {
    request = await settleFromReturn(store, request, sessionId);
    // The receipt and the order's count, once, whichever of this page and the five-minute job is first.
    if (request.state === "paid" && request.session === sessionId) await confirmPurchase(store, sessionId).catch((error) => console.error("confirming a payment request failed", error));
  }
  const now = new Date().getTime();
  const status = statusOf(request, now);
  const said = speechFor(store.language, request.currency);
  const w = requestWords(store.language);
  const notice = typeof query.notice === "string" ? w.notices[query.notice] : undefined;
  const day = (d: string) => said.date(Date.parse(`${d}T12:00:00Z`));
  const total = said.money(request.total);
  const payable = status === "open" && requestsOpen(store);
  const rehearsal = payable && sellsInTestMode(store);
  const reportUrl = `/report?url=${encodeURIComponent(`${SITE_URL}/@${store.handle}`)}`;

  const heading =
    status === "paid" ? w.paidTitle
    : status === "refunded" ? w.refundedTitle
    : status === "canceled" ? w.canceledTitle
    : status === "expired" ? w.expiredTitle
    : sessionId ? w.waitingTitle
    : w.pageTitle;

  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-12 sm:py-16">
        <div className="st-card p-6 sm:p-10">
          <p className="st-muted text-sm font-semibold">{w.eyebrow(store.name)}</p>
          <h1 className="mt-2 font-display text-3xl font-semibold leading-tight sm:text-4xl">{heading}</h1>
          {status === "paid" ? (
            <p className="st-muted mt-4 text-lg">
              {request.outside
                ? w.paidOutsideBody(said.money(request.amountPaid || request.total), store.name, said.date(request.paidAt || now), request.outside.method)
                : w.paidBody(said.money(request.amountPaid || request.total), store.name, said.date(request.paidAt || now))}
            </p>
          ) : null}
          {status === "paid" && request.refunded > 0 ? <p className="st-muted mt-2">{w.partRefund(said.money(request.refunded))}</p> : null}
          {status === "refunded" ? <p className="st-muted mt-4 text-lg">{w.refundedBody(said.money(request.refunded || request.amountPaid), store.name)}</p> : null}
          {status === "canceled" ? <p className="st-muted mt-4 text-lg">{w.canceledBody(store.name)}</p> : null}
          {status === "expired" ? <p className="st-muted mt-4 text-lg">{w.expiredBody(store.name)}</p> : null}
          {status === "open" && sessionId ? <p className="st-muted mt-4">{w.waitingBody}</p> : null}
          {status === "open" && !sessionId ? <p className="st-muted mt-4 text-lg">{w.lead(store.name)}</p> : null}
          {notice ? (
            <div className="st-note mt-5" role="alert">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
              <p className="mt-1 text-sm">{notice.body}</p>
            </div>
          ) : null}

          <table className="mt-6 w-full text-left text-sm">
            <thead>
              <tr className="st-muted">
                <th scope="col" className="py-2 pr-3 font-semibold">{w.item}</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">{w.quantity}</th>
                <th scope="col" className="py-2 text-right font-semibold">{w.amount}</th>
              </tr>
            </thead>
            <tbody>
              {request.lines.map((line, i) => (
                <tr key={i} className="border-t" style={{ borderColor: "var(--st-line, rgba(0,0,0,0.1))" }}>
                  <td className="py-2 pr-3 [overflow-wrap:anywhere]">{line.text}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{said.num(line.quantity)}</td>
                  <td className="py-2 text-right tabular-nums">{said.money(line.cents * line.quantity)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-semibold" style={{ borderColor: "var(--st-line, rgba(0,0,0,0.1))" }}>
                <td className="py-2 pr-3" colSpan={2}>{w.total}</td>
                <td className="py-2 text-right tabular-nums">{total}</td>
              </tr>
            </tfoot>
          </table>
          {request.dueDate && status === "open" ? <p className="mt-3 text-sm font-semibold">{w.due(day(request.dueDate))}</p> : null}
          {request.note ? (
            <div className="mt-5">
              <p className="text-sm font-semibold">{w.note}</p>
              <p className="st-muted mt-1 whitespace-pre-line text-sm [overflow-wrap:anywhere]">{request.note}</p>
            </div>
          ) : null}

          {payable ? (
            <form action="/api/store/pay-request" method="post" target="_top" className="mt-7">
              <input type="hidden" name="handle" value={store.handle} />
              <input type="hidden" name="request" value={request.id} />
              <button type="submit" className="btn st-btn w-full">{w.pay(total)}</button>
              <p className="st-muted mt-3 text-sm">{w.secure(store.name)}</p>
              {store.tax.enabled ? <p className="st-muted mt-1 text-sm">{w.tax}</p> : null}
              <p className="st-muted mt-1 text-sm">{w.until(said.date(request.expiresAt))}</p>
              {rehearsal ? <p className="st-muted mt-1 text-sm font-semibold">{w.testMode}</p> : null}
            </form>
          ) : status === "open" && !sessionId ? (
            <p className="st-muted mt-6 text-sm">{w.notices.closed.title}. {w.notices.closed.body}</p>
          ) : null}

          {status === "paid" || status === "refunded" ? (
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <p className="st-muted">{`${w.reference}: ${request.payment || request.id}`}</p>
              <PrintButton label={w.print} />
            </div>
          ) : null}

          {status === "open" ? <p className="st-muted mt-6 text-sm">{w.notYou(store.name)}</p> : null}
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
            <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
              {w.visit(store.name)}
            </Link>
            {status === "open" ? (
              <Link href={reportUrl} prefetch={false} rel="nofollow" className="st-footer-link text-sm">
                {w.report}
              </Link>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
