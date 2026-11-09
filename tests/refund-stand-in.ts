/**
 * GET /refunds?charge= as Stripe answers it, for the stand-ins of tests whose payment reads refunded in full
 * (the owner's decision 18, lib/refunds.ts moneyBack): Stripe counts a refund still on its way in the charge's
 * `amount_refunded` too, so a door asks the charge's own refunds before it closes. `status` "succeeded" is a full
 * refund gone through; "pending" one still on its way.
 *
 * Synthetic only.
 */
export function chargeRefundList(charge: string, amount: number, status = "succeeded"): Record<string, unknown> {
  return {
    object: "list",
    has_more: false,
    data: [{ id: `re_${charge.replace(/^(ch|py)_/, "")}`, object: "refund", status, amount, created: 1_700_000_000, charge }],
  };
}
