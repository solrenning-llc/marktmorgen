/**
 * Discount codes through the API (630 [HN6](19), unit 2): read, made and
 * switched off on the creator's own Stripe account, exactly as the studio's
 * discount codes are (lib/discount.ts, app/api/store/discount). A code is
 * never deleted from Stripe, which keeps its redemptions; switching it off
 * is what "remove" means, here as in the studio. Each code goes out field by
 * field (lib/api-read.ts's rule), every time in ISO 8601.
 */
import { CODE_PROBLEMS, type DiscountCode, amountProblem, minimumProblem } from "@/lib/discount";
import type { CodeAskedRefusal } from "@/lib/discount-input";
import type { Currency } from "@/lib/money";

/** One code as the API gives it out. */
export function codeOut(code: DiscountCode): Record<string, unknown> {
  return {
    id: code.id,
    code: code.code,
    off: code.off === null ? null : code.off.kind === "percent" ? { kind: "percent", percent: code.off.percent } : { kind: "amount", amount_cents: code.off.cents, currency: code.off.currency },
    times_redeemed: code.timesRedeemed,
    max_redemptions: code.maxRedemptions,
    expires_at: code.expiresAt ? new Date(code.expiresAt * 1000).toISOString() : null,
    active: code.active,
    minimum: code.minimum ? { amount_cents: code.minimum.cents, currency: code.minimum.currency } : null,
    first_order: code.firstOrder,
    duration: code.duration === null ? null : code.duration.kind === "repeating" ? { kind: "repeating", months: code.duration.months } : { kind: code.duration.kind },
    other_rules: code.otherRules,
  };
}

/** What is wrong with a code asked for, in the words the studio uses, in the store's currency. */
export function refusalWords(refusal: CodeAskedRefusal, currency: Currency): string {
  if (refusal.reason === "amount") return amountProblem(currency);
  if (refusal.reason === "minimum") return minimumProblem(currency);
  return CODE_PROBLEMS[refusal.reason];
}
