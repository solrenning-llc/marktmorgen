/**
 * 361 [AP1] (d): the creator's own discount on the first year, offered only
 * through the one email that offers a monthly member the yearly price
 * (lib/yearly-ask.ts), as rules (docs/ap1-autopilot-design.md).
 *
 * It is the creator's money on the creator's own Stripe account: a coupon off
 * the first yearly charge, once, so the year renews at the creator's own
 * yearly price, which the email says. Never for a member who did not come
 * through that email, who already has a discount, or who has no yearly price
 * to move to. Pure and browser-safe.
 */
import type { YearlyChoice } from "@/lib/yearly-switch-rules";

/** The percents a creator may choose; none (0) by default. */
export const YEARLY_ASK_PERCENTS = [5, 10, 15, 20, 25] as const;

/** The creator's percent as kept: one of YEARLY_ASK_PERCENTS, or 0 for none. */
export function readAskPercent(raw: unknown): number {
  return typeof raw === "number" && (YEARLY_ASK_PERCENTS as readonly number[]).includes(raw) ? raw : 0;
}

export type AskOffer = { percent: number; firstYearCents: number; renewalCents: number };

/** The first year less the creator's percent, rounded to the cent, then the creator's yearly price; null for none. */
export function askOffer(choice: YearlyChoice, percent: number): AskOffer | null {
  const kept = readAskPercent(percent);
  if (!kept) return null;
  return { percent: kept, firstYearCents: choice.cents - Math.round((choice.cents * kept) / 100), renewalCents: choice.cents };
}

/** Whether the discount applies to this switch: through the email, to a yearly price, with no discount already, a percent set. */
export function offerApplies(input: { emailed: boolean; choice: YearlyChoice | null; percent: number; discounted: boolean }): boolean {
  return input.emailed && input.choice !== null && !input.discounted && readAskPercent(input.percent) > 0;
}

/** The coupon made on the creator's account for it: percent off, once (the first yearly charge only), never repeating. */
export function askCouponBody(percent: number): URLSearchParams {
  const kept = readAskPercent(percent);
  return new URLSearchParams({
    percent_off: String(kept),
    duration: "once",
    name: `Yearly offer: ${kept}% off the first year`,
    "metadata[kind]": "yearly-ask",
  });
}
