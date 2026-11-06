import { DISPUTE_KEPT_WORDS, DISPUTE_OUTCOME_WORDS, DISPUTE_PAUSED_WORDS } from "@/lib/plan-dispute-rules";

/**
 * What the studio shows while a payment for the plan is disputed with the
 * creator's bank (232 [CA1] unit 5): what is paused, what is not, and what
 * happens when the bank decides. The Terms say the same words.
 */
export function PlanDisputeNotice() {
  return (
    <section id="plan-disputed" aria-labelledby="plan-disputed-title" className="notice notice-warn mt-6 scroll-mt-24">
      <h2 id="plan-disputed-title" className="font-bold text-ink">
        A payment for your plan is disputed with your bank
      </h2>
      <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">{DISPUTE_PAUSED_WORDS}</p>
      <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">{DISPUTE_KEPT_WORDS}</p>
      <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-ink-soft">{DISPUTE_OUTCOME_WORDS}</p>
    </section>
  );
}
