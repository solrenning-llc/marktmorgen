import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { EmailField } from "@/components/email-field";
import { studioPath, studioView } from "@/lib/studio-route";
import { STORE_ID_PATTERN } from "@/lib/store";
import { answerId } from "@/lib/help-content";
import { withinLimit } from "@/lib/request-guard";
import { readPlanRefund } from "@/lib/plan-refund";
import { issueReview } from "@/lib/plan-refund-flow";
import { refundUnderway } from "@/lib/plan-refund-underway";
import { REFUND_DONE, SUPPORT_ADDRESS, moneyOf, refundEffects, refusalWords } from "@/lib/plan-refund-words";
import { PLAN_NAMES } from "@/lib/plan";
import { PLAN_WITHDRAW_ACK_SENDS, PLAN_WITHDRAW_SUPPORT_TRIES, planWithdrawWindow, planWithdrawal } from "@/lib/plan-withdrawal";
import { PLAN_WITHDRAW_WORDS as W } from "@/lib/plan-withdrawal-words";

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** The tab's title says the outcome, so it is heard when the page opens after a confirmation (WCAG 2.4.2, 4.1.3). */
export async function generateMetadata({ searchParams }: Params): Promise<Metadata> {
  const query = await searchParams;
  const done = typeof query.done === "string" ? REFUND_DONE[query.done] : undefined;
  const withdrew = withdrawNoticeOf(query.withdraw);
  return { title: `${done ? done.title : withdrew ? withdrew.title : "Refund your payment"} — Marktmorgen`, robots: { index: false, follow: false } };
}

export const dynamic = "force-dynamic";

/** Reviews a store may open in a day: each reads Stripe a bounded number of times (lib/plan-refund.ts, MAX_CALLS). */
const SHOWN_PER_DAY = 20;

/** A payment's date, as the receipt shows it. */
const paidOn = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The answer of the withdrawal route (app/api/billing/withdraw), when the address carries a known one. */
function withdrawNoticeOf(value: unknown) {
  return typeof value === "string" && Object.hasOwn(W.notices, value) ? W.notices[value] : undefined;
}

/** A moment as the receipt says it: "November 6, 2026 at 18:05 UTC". */
const momentOf = (ms: number) =>
  `${new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })} at ${new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" })} UTC`;

/** Breadcrumb links big enough to press (WCAG 2.5.5: 44 by 44 px). */
const CRUMB = "inline-flex min-h-[44px] items-center underline underline-offset-2";

/**
 * The plan refund's review page (305 [SY1], AX274 3.3.6): the exact amount
 * the published policy gives today, what happens to the store, and a way
 * back without changing anything. The button posts the one-time pass this
 * page issues, so a refund is never made without this page. No reason is
 * asked. Nothing is refunded by opening it.
 */
export default async function StudioRefundPage({ searchParams }: Params) {
  const query = await searchParams;
  if (query.store !== undefined && (typeof query.store !== "string" || !STORE_ID_PATTERN.test(query.store))) redirect("/studio");
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "billing", { count: false });
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  // Never a refund for another store than the one asked for.
  if (found.fellBack) redirect(studioPath(found.view.store));
  const { view } = found;
  const { store } = view;
  const name = store.name || store.handle;
  const back = `${studioPath(store)}#billing`;
  const owner = view.role === "owner";
  const done = !owner ? REFUND_DONE.owner : typeof query.done === "string" ? REFUND_DONE[query.done] : undefined;
  const finished = query.done === "refunded" || query.done === "ending";
  // A refund still being settled: no new confirmation until it is decided.
  const underway = owner && !finished ? await refundUnderway(store.sid).catch(() => true) : false;
  const settling = underway && !done ? REFUND_DONE.busy : null;
  const notice = done ?? settling;
  // A withdrawal from the plan (588 [KB9] unit 3): once recorded, it is said and never offered again. A record that
  // cannot be read is not taken for "not withdrawn": the form may still show, and the route reads it exactly.
  const subscription = store.subscriptionId ?? "";
  const kept = owner && subscription ? await planWithdrawal(store).catch(() => null) : null;
  const withdrawn = kept && kept.at !== null ? { ...kept, at: kept.at } : null;
  const withdrawNotice = withdrawNoticeOf(query.withdraw);
  const shown = owner && !finished && !underway && !withdrawn ? await withinLimit("plan-refund-review", store.sid || store.handle, SHOWN_PER_DAY, 86_400) : false;
  const reading = shown ? await readPlanRefund(store) : null;
  const owed = reading && (reading.refund.kind === "guarantee" || reading.refund.kind === "unstarted_months") && "currency" in reading ? reading : null;
  const token = owed ? await issueReview(store.sid, owed.refund.cents) : "";
  const refusal = reading && !owed && reading.refund.kind !== "guarantee" && reading.refund.kind !== "unstarted_months" ? refusalWords({ refund: reading.refund }) : null;
  const amount = owed ? moneyOf(owed.refund.cents, owed.currency) : "";
  const offer = owner && !finished && !underway && !withdrawn;
  // Inside the 14 days from the plan payment, or while Stripe could not be read at all (never hidden on a guess); an
  // "unknown" from the account's own data is shown as the refusal above, which sends the creator to support.
  const withdrawWindow = offer && subscription ? planWithdrawWindow(shown ? reading : null) : null;
  const withdrawOpen = withdrawWindow?.open === true ? withdrawWindow : null;
  const resend = withdrawn !== null && !withdrawn.sent && withdrawn.tries < PLAN_WITHDRAW_ACK_SENDS;
  // A refund support has not been told about yet: said, and the form offered again while a try is left.
  const supportOwed = withdrawn !== null && withdrawn.refund && withdrawn.support !== null && !withdrawn.told;
  const supportRetry = supportOwed && withdrawn.supportTries < PLAN_WITHDRAW_SUPPORT_TRIES;
  const planName = `${PLAN_NAMES[store.tier] ?? "Marktmorgen"} for ${name}`;
  const ownerEmail = view.email || store.email;
  const withdrawForm = (
    <form action={`/api/billing/withdraw?store=${encodeURIComponent(store.sid)}`} method="post" className="mt-5 space-y-5">
      <dl className="space-y-1 text-ink">
        <div><dt className="inline font-semibold">{`${W.planLabel}: `}</dt><dd className="inline">{planName}</dd></div>
        <div><dt className="inline font-semibold">{`${W.subscriptionLabel}: `}</dt><dd className="inline" data-withdraw-contract="">{subscription}</dd></div>
      </dl>
      <div>
        <label htmlFor="withdraw-name" className="field-label">{W.nameLabel}</label>
        <p id="withdraw-name-hint" className="field-hint mt-1">{W.nameHint}</p>
        <input id="withdraw-name" name="name" type="text" autoComplete="name" required maxLength={200} aria-describedby="withdraw-name-hint" className="field mt-2 max-w-md" />
      </div>
      <div>
        <label htmlFor="withdraw-email" className="field-label">{W.emailLabel}</label>
        <p id="withdraw-email-hint" className="field-hint mt-1">{W.emailHint}</p>
        <EmailField id="withdraw-email" name="email" className="field mt-2" wrapClassName="max-w-md" required autoComplete="email" defaultValue={ownerEmail} describedBy="withdraw-email-hint" store={false} />
      </div>
      <button type="submit" className="btn btn-primary inline-flex min-h-[44px] items-center justify-center">{W.confirm}</button>
    </form>
  );

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: back, label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <nav aria-label="Breadcrumb" className="mb-4 text-sm text-ink-soft">
            <ol className="flex flex-wrap items-center gap-2">
              <li><Link href={studioPath(store)} className={CRUMB}>Studio</Link> <span aria-hidden="true">›</span></li>
              <li><Link href={back} className={CRUMB}>What you pay us</Link> <span aria-hidden="true">›</span></li>
              <li aria-current="page">Refund your payment</li>
            </ol>
          </nav>
          <div className="card max-w-2xl p-6 sm:p-8">
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-ink sm:text-3xl">{`Refund your payment for ${name}`}</h1>
            {withdrawOpen ? (
              <p className="mt-4"><a href="#withdraw" className="btn btn-secondary inline-flex min-h-[44px] items-center justify-center" data-withdraw-link="">{W.link}</a></p>
            ) : null}
            {notice ? (
              <div className={`mt-5 notice ${notice.tone === "success" ? "notice-success" : "notice-warn"}`} role="status" data-refund-done={done ? (owner ? query.done : "owner") : "busy"}>
                <p className="font-semibold">{notice.title}</p>
                <p className="mt-1">{notice.body}</p>
              </div>
            ) : null}
            {!offer ? null : !shown ? (
              <p className="mt-4 text-ink-soft">{`This page was opened many times today. Please come back tomorrow, or email ${SUPPORT_ADDRESS}.`}</p>
            ) : owed ? (
              <>
                <h2 className="mt-6 text-lg font-semibold text-ink">What you get back</h2>
                <p className="mt-2 text-ink" data-refund-amount={owed.refund.cents}>
                  {owed.refund.kind === "guarantee"
                    ? owed.parts.length === 1
                      ? `${amount}: the plan payment listed below, in full, under the money-back guarantee.`
                      : `${amount}: the ${owed.parts.length} plan payments listed below, each in full, under the money-back guarantee.`
                    : `${amount}: the months of your yearly plan that have not started. We keep ${owed.refund.monthsKept === 1 ? "the month that has started" : `the ${owed.refund.monthsKept} months that have started`}, each at the monthly price, and the card fee Stripe kept.`}
                </p>
                <h3 className="mt-4 font-semibold text-ink">{owed.parts.length === 1 ? "The payment refunded" : `The ${owed.parts.length} payments refunded`}</h3>
                <ul className="mt-2 list-disc space-y-1 pl-6 text-ink" data-refund-parts={owed.parts.length}>
                  {owed.parts.map((part) => (
                    <li key={part.chargeId}>{`${moneyOf(part.cents, owed.currency)}${owed.refund.kind === "guarantee" ? "" : " of your yearly payment"}, paid on ${paidOn(part.paidAtSeconds)}`}</li>
                  ))}
                </ul>
                <p className="mt-2 text-ink-soft">It goes back to the card or account you paid with. Your bank may take a few days to show it. No reason is needed.</p>
                <h2 className="mt-6 text-lg font-semibold text-ink">{`What happens to ${name}`}</h2>
                <ul className="mt-2 list-disc space-y-2 pl-6 text-ink-soft">
                  {refundEffects({ assistant: Boolean(store.assistantPlan?.active) }).map((line) => <li key={line}>{line}</li>)}
                </ul>
                <p className="mt-3 text-ink-soft"><Link href={`/help#${answerId("What happens when my plan ends?")}`} className={CRUMB}>Read what happens when a plan ends, in the Help</Link></p>
                <form action={`/api/billing/refund?store=${encodeURIComponent(store.sid)}`} method="post" className="mt-8 flex flex-wrap items-center gap-4">
                  <input type="hidden" name="review" value={token} />
                  <button type="submit" className="btn btn-primary">{`Refund ${amount} and end the plan for ${name}`}</button>
                  <Link href={back} className="btn btn-secondary">Go back without changing anything</Link>
                </form>
              </>
            ) : refusal ? (
              <>
                <h2 className="mt-6 text-lg font-semibold text-ink" data-refund-refused="">{refusal.title}</h2>
                <p className="mt-2 text-ink-soft">{refusal.body}</p>
                <p className="mt-6"><Link href={back} className="btn btn-secondary">Back to the studio</Link></p>
              </>
            ) : null}
            {withdrawOpen || withdrawn || withdrawNotice ? (
              <section id="withdraw" aria-labelledby="withdraw-title" className="mt-10 border-t border-line pt-6">
                <h2 id="withdraw-title" className="text-lg font-semibold text-ink">{W.title}</h2>
                {withdrawNotice ? (
                  <div className={`mt-4 notice ${withdrawNotice.tone === "success" ? "notice-success" : "notice-warn"}`} role="status" data-withdraw-done={String(query.withdraw)}>
                    <p className="font-semibold">{withdrawNotice.title}</p>
                    <p className="mt-1">{withdrawNotice.body}</p>
                  </div>
                ) : null}
                {withdrawn ? (
                  <>
                    <p className="mt-4 text-ink" data-withdrawn={withdrawn.at}>{W.withdrawn(momentOf(withdrawn.at))}</p>
                    <p className="mt-2 text-ink-soft">{withdrawn.sent ? W.receiptSent : resend ? W.receiptUnsent : W.receiptGiveUp}</p>
                    {supportOwed ? <p className="mt-2 text-ink" data-withdraw-support={supportRetry ? "retry" : "unreached"}>{supportRetry ? W.supportUnsent : W.supportGiveUp(subscription)}</p> : null}
                    {resend || supportRetry ? withdrawForm : null}
                  </>
                ) : withdrawOpen ? (
                  <>
                    <p className="mt-3 text-ink">{W.lead(planName)}</p>
                    <p className="mt-2 text-ink-soft">{withdrawOpen.until === null ? W.noEnd : W.until(momentOf(withdrawOpen.until * 1000))}</p>
                    <p className="mt-2 text-ink-soft">{reading?.refund.kind === "guarantee" ? W.next : W.nextChecked}</p>
                    {withdrawForm}
                  </>
                ) : null}
              </section>
            ) : null}
            {!offer ? <p className="mt-6"><Link href={back} className="btn btn-secondary">Back to the studio</Link></p> : null}
          </div>
        </main>
      </StudioStorePin>
    </div>
  );
}
