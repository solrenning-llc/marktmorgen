import type { SubscriptionState } from "@/lib/billing";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import type { Cycle } from "@/lib/plan";
import { RENEWAL_KEPT_WORDS, RENEWAL_PAUSED_WORDS, RENEWAL_RESUME_WORDS } from "@/lib/renewal-unpaid-words";

/**
 * The studio's notice when the plan's renewal payment did not go through
 * (232 [CA1] unit 4): what has stopped, what has not, and the one thing to
 * do. Drawn on the server; no script. `payUrl` is Stripe's own page for the
 * open invoice (lib/billing.ts, renewalInvoicePage), read on this load; when
 * Stripe did not give one, the notice says how to get it from a person.
 * `canPay` is false for a team member without the billing permission, who
 * is told to ask the owner instead of being shown a link to pay.
 */
export function RenewalUnpaidNotice({ payUrl, canPay }: { payUrl: string | null; canPay: boolean }) {
  return (
    <section id="renewal-unpaid" aria-labelledby="renewal-unpaid-title" className="notice notice-warn mt-6 scroll-mt-24">
      <h2 id="renewal-unpaid-title" className="font-bold text-ink">
        Your plan&apos;s renewal payment did not go through
      </h2>
      <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">{RENEWAL_PAUSED_WORDS}</p>
      <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">{RENEWAL_KEPT_WORDS}</p>
      {canPay ? (
        payUrl ? (
          <p className="mt-2 max-w-[80ch] text-sm leading-relaxed text-ink-soft">
            <a href={payUrl} className="inline-flex min-h-11 items-center font-bold text-ink underline underline-offset-4">
              Pay the open invoice on Stripe&apos;s page
            </a>{" "}
            (you can use the same card or another one). {RENEWAL_RESUME_WORDS} Then reload this page.
          </p>
        ) : (
          <p className="mt-2 max-w-[80ch] text-sm leading-relaxed text-ink-soft">
            We could not get the page that pays it just now. Reload this page in a minute, or write to{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="inline-flex min-h-11 items-center font-bold text-ink underline underline-offset-4">
              {SUPPORT_EMAIL}
            </a>{" "}
            and we will send you the link. {RENEWAL_RESUME_WORDS}
          </p>
        )
      ) : (
        <p className="mt-2 max-w-[80ch] text-sm leading-relaxed text-ink-soft">
          Only someone who manages billing for this store can pay it. Ask the store owner. {RENEWAL_RESUME_WORDS}
        </p>
      )}
    </section>
  );
}

/**
 * A plan amount as Stripe has it, written the way the card writes it:
 * "$69 a month", "$4,490 a year", "$69.50 a month".
 */
export function planAmountWords(cents: number, cycle: Cycle): string {
  const dollars = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
  return `$${dollars} a ${cycle}`;
}

/** How close a charge has to be for the studio to say so at the top: seven days. */
export const PLAN_DUE_SOON_SECONDS = 7 * 86_400;

export type PlanDueSoon = { kind: "trial" | "renewal"; at: number; amountCents: number; cycle: Cycle };

/**
 * The end of the free trial, or a yearly renewal, seven days away or less,
 * from the subscription the studio already read on this load (no new call to
 * Stripe). Nothing when Stripe could not be asked, when it does not pay, when
 * it is set to stop, while a change of billing waits on the bank, while the
 * renewal is unpaid (RenewalUnpaidNotice says that), or without an amount or
 * a date from Stripe. A monthly renewal is not announced.
 */
export function planDueSoon(live: SubscriptionState | null | undefined, nowSeconds: number): PlanDueSoon | null {
  if (!live || live.state !== "active") return null;
  if (live.cancelsAtEnd || live.changePending || live.renewalUnpaid) return null;
  if (!(live.amountCents > 0) || !(live.until > nowSeconds) || live.until - nowSeconds > PLAN_DUE_SOON_SECONDS) return null;
  if (live.trialing) return { kind: "trial", at: live.until, amountCents: live.amountCents, cycle: live.cycle };
  if (live.cycle === "year") return { kind: "renewal", at: live.until, amountCents: live.amountCents, cycle: live.cycle };
  return null;
}

/**
 * The studio's notice that the trial ends, or the yearly plan renews, within
 * seven days, for someone who manages billing. The same words as the "What
 * you pay us" card: the plan's price and the day, never a promise of the
 * exact amount an invoice will take. Drawn on the server; no script.
 */
export function PlanDueSoonNotice({ due }: { due: PlanDueSoon }) {
  const day = new Date(due.at * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const amount = planAmountWords(due.amountCents, due.cycle);
  return (
    <section id="plan-due-soon" role="status" aria-labelledby="plan-due-soon-title" className="notice notice-info mt-6 scroll-mt-24">
      <h2 id="plan-due-soon-title" className="font-bold text-ink">
        {due.kind === "trial" ? "Your free trial ends soon" : "Your yearly plan renews soon"}
      </h2>
      <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">
        {due.kind === "trial"
          ? `Your trial ends on ${day}; then ${amount}. No card has been charged yet. If you cancel before then, your card is never charged.`
          : `Your plan renews on ${day} at ${amount}. If you cancel before then, nothing more is charged.`}
      </p>
      <p className="mt-2 max-w-[80ch] text-sm leading-relaxed text-ink-soft">
        <a href="#billing" className="inline-flex min-h-11 items-center font-bold text-ink underline underline-offset-4">See or cancel your plan</a>
      </p>
    </section>
  );
}

/**
 * In the "What you pay us" card when Stripe did not confirm the plan on this
 * load: no amount and no date, rather than the price list's figure.
 */
export function PlanUnconfirmedNotice() {
  return (
    <div className="mt-5 notice notice-warn" role="status" data-plan-unconfirmed="">
      <p className="font-semibold text-ink">
        We could not confirm your plan with Stripe just now, so its price and next charge date are not shown. Nothing about your plan was changed.
      </p>
      <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">
        Reload this page in a minute. If this keeps happening, write to{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="inline-flex min-h-11 items-center font-bold text-ink underline underline-offset-4">
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
    </div>
  );
}
