import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { STORE_ID_PATTERN } from "@/lib/store";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { ClosingRefundsConfirm } from "@/components/closing-refunds-confirm";
import { closingOf } from "@/lib/plan-closing";
import { reviewMark, unusedSummary } from "@/lib/closing-refunds";
import { REFUNDS_PER_REQUEST } from "@/lib/closing-buyers-rules";
import { formatMoney } from "@/lib/money";

export const metadata: Metadata = { title: "Refund unused time — Marktmorgen", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
type Params = { searchParams: Promise<{ store?: string | string[] }> };

/** A read that either answered or could not be made: a failure is never taken for "nothing" (audit SG2). */
type Read<T> = { ok: true; value: T } | { ok: false };
const read = <T,>(work: Promise<T>, what: string): Promise<Read<T>> =>
  work.then((value) => ({ ok: true as const, value }), (error: unknown) => {
    console.error(`reading ${what} for the refund review failed`, error);
    return { ok: false as const };
  });

/*
 * Only what the code does (rule 27): the closing day tries the refunds this page lists (lib/closing-refunds.ts,
 * giveBackUnused over unusedRows), and one can still fail. Members the hold never wrote down (past its call
 * budget, failed, on a payment plan, or paid before it ran) are never listed, so are the creator's to refund.
 */
const CAN_FAIL = "A refund can fail, for example when your balance is too low.";
const UNLISTED = "If someone paid for time after that day and is not listed, refund them in Stripe.";

const dayWords = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/**
 * The review screen before giving back members' unused time (queue item 307
 * [EC1], part 4; WCAG 3.3.6, a review before money moves): every amount,
 * where it comes from and what happens if the balance does not cover it,
 * one button to confirm and one to go back. Nothing is asked of the creator
 * but that press. Reusable by the plan refund of item 305 [SY1] for the
 * store's members: the figures come from lib/closing-refunds.ts.
 */
export default async function ClosingRefundsPage({ searchParams }: Params) {
  const query = await searchParams;
  if (query.store !== undefined && (typeof query.store !== "string" || !STORE_ID_PATTERN.test(query.store))) redirect("/studio");
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "billing");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  if (found.fellBack) redirect(studioPath(found.view.store));
  const { view } = found, { store } = view;
  const back = `${studioPath(store)}#closing`;
  // closingOf answers null only when the store is not closing; a failed read is told apart from that.
  const closingRead = await read(closingOf(store), "the store's closing");
  const closing = closingRead.ok ? closingRead.value : null;
  const summaryRead = closing ? await read(unusedSummary(store, closing.day), "the members' payments") : null;
  const summary = summaryRead?.ok ? summaryRead.value : null;
  const rows = summary ? summary.rows.slice(0, REFUNDS_PER_REQUEST) : [];
  const total = summary ? summary.totals.map((t) => formatMoney(t.amount, t.cur)).join(" and ") : "";
  return <div className="min-h-screen bg-paper text-ink">
    <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: back, label: "Back to the studio", short: "Studio" }} />
    <StudioStorePin sid={store.sid}>
      <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
        <nav aria-label="Breadcrumb" className="text-sm text-ink-soft">
          <ol className="flex flex-wrap gap-2">
            <li><a href={back} className="underline">Studio</a> <span aria-hidden="true">/</span></li>
            <li aria-current="page">Refund unused time</li>
          </ol>
        </nav>
        <h1 className="t-h2 mt-3">Refund the time your members paid for after your store closes</h1>
        {!closingRead.ok ? (
          <p className="mt-4 max-w-2xl text-ink-soft">{`We could not check whether your store is closing just now. Please reload this page in a minute. If your store is closing, on its closing day we try to make the refunds this page lists, from your Stripe balance. ${CAN_FAIL} ${UNLISTED}`}</p>
        ) : !closing ? (
          <p className="mt-4 max-w-2xl text-ink-soft">Your store is not closing, so there is nothing to refund here.</p>
        ) : !summaryRead?.ok ? (
          <p className="mt-4 max-w-2xl text-ink-soft">{`We could not read your members' payments just now. Please reload this page in a minute. Your store is set to close on ${dayWords(closing.day)}. On that day we try to make the refunds this page lists, from your Stripe balance. ${CAN_FAIL} ${UNLISTED}`}</p>
        ) : !rows.length ? (
          <p className="mt-4 max-w-2xl text-ink-soft">{`This page lists no refund to make. Your store is set to close on ${dayWords(closing.day)}. ${UNLISTED}`}</p>
        ) : (
          <>
            <div className="mt-4 max-w-2xl space-y-3 text-ink-soft">
              <p>{`Your store closes on ${dayWords(closing.day)}. These members paid for time after that day. Each refund is the unused part of their last payment: the payment times the share of its period that falls after that day.`}</p>
              <p>The money comes from your own Stripe account. Marktmorgen never pays it and never takes any of it. If your balance does not cover a refund, that refund is not made, and you are told here.</p>
              <p>{`If you do nothing, we try to make the same refunds on ${dayWords(closing.day)}, from your Stripe balance. ${CAN_FAIL} ${UNLISTED}${closing.today ? "" : " Starting a plan again before then keeps your store, and then nothing is refunded."}`}</p>
            </div>
            <section aria-labelledby="refund-list" className="mt-8">
              <h2 id="refund-list" className="t-h3">{`${rows.length} ${rows.length === 1 ? "refund" : "refunds"}, ${total} in all`}</h2>
              <div className="mt-4 max-w-full overflow-x-auto" role="region" aria-label="Refunds to make" tabIndex={0}>
                <table className="min-w-full text-left text-sm">
                  <caption className="sr-only">Each member, the last day they paid for, and their refund</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="py-2 pr-4">Member</th>
                      <th scope="col" className="py-2 pr-4">Paid for until</th>
                      <th scope="col" className="py-2 pr-4">Last payment</th>
                      <th scope="col" className="py-2">Refund</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.sub} className="border-t border-line">
                        <td className="py-2 pr-4 break-all">{row.paid.e || "A member with no email on Stripe"}</td>
                        <td className="py-2 pr-4">{dayWords(row.paid.pe * 1000)}</td>
                        <td className="py-2 pr-4">{formatMoney(row.paid.amt, row.paid.cur)}</td>
                        <td className="py-2 font-semibold text-ink">{formatMoney(row.unused, row.paid.cur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {summary && summary.rows.length > rows.length ? (
                <p className="mt-3 text-sm text-ink-soft">{`${summary.rows.length - rows.length} more are listed after these are done.`}</p>
              ) : null}
              <ClosingRefundsConfirm mark={reviewMark(rows)} label={`Refund ${total} to ${rows.length} ${rows.length === 1 ? "member" : "members"}`} back={back} />
            </section>
          </>
        )}
      </main>
    </StudioStorePin>
  </div>;
}
