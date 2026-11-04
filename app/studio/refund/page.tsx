import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { studioPath, studioView } from "@/lib/studio-route";
import { STORE_ID_PATTERN } from "@/lib/store";
import { answerId } from "@/lib/help-content";
import { withinLimit } from "@/lib/request-guard";
import { readPlanRefund } from "@/lib/plan-refund";
import { issueReview } from "@/lib/plan-refund-flow";
import { refundUnderway } from "@/lib/plan-refund-underway";
import { REFUND_DONE, SUPPORT_ADDRESS, moneyOf, refundEffects, refusalWords } from "@/lib/plan-refund-words";

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** The tab's title says the outcome, so it is heard when the page opens after a confirmation (WCAG 2.4.2, 4.1.3). */
export async function generateMetadata({ searchParams }: Params): Promise<Metadata> {
  const query = await searchParams;
  const done = typeof query.done === "string" ? REFUND_DONE[query.done] : undefined;
  return { title: `${done ? done.title : "Refund your payment"} — Marktmorgen`, robots: { index: false, follow: false } };
}

export const dynamic = "force-dynamic";

/** Reviews a store may open in a day: each reads Stripe a bounded number of times (lib/plan-refund.ts, MAX_CALLS). */
const SHOWN_PER_DAY = 20;

/** A payment's date, as the receipt shows it. */
const paidOn = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

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
  const shown = owner && !finished && !underway ? await withinLimit("plan-refund-review", store.sid || store.handle, SHOWN_PER_DAY, 86_400) : false;
  const reading = shown ? await readPlanRefund(store) : null;
  const owed = reading && (reading.refund.kind === "guarantee" || reading.refund.kind === "unstarted_months") && "currency" in reading ? reading : null;
  const token = owed ? await issueReview(store.sid, owed.refund.cents) : "";
  const refusal = reading && !owed && reading.refund.kind !== "guarantee" && reading.refund.kind !== "unstarted_months" ? refusalWords({ refund: reading.refund }) : null;
  const amount = owed ? moneyOf(owed.refund.cents, owed.currency) : "";
  const offer = owner && !finished && !underway;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-[10px] focus:bg-white focus:px-4 focus:py-2.5 focus:font-semibold focus:text-violet-deep focus:shadow-lg"
      >
        Skip to the page content
      </a>
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
            {!offer ? <p className="mt-6"><Link href={back} className="btn btn-secondary">Back to the studio</Link></p> : null}
          </div>
        </main>
      </StudioStorePin>
    </div>
  );
}
