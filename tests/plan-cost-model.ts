/**
 * The per-plan worst-case cost model shared by tests/plan-margin.test.ts and
 * tests/spend-floor.test.ts. Moved here on October 17, 2026 so the two files
 * cannot hold different figures; the same day its lines moved into
 * tests/plan-cost-registry.ts, one line per metered feature with the code that
 * enforces it, so a feature cannot be left out of the worst month
 * (tests/plan-cost-registry.test.ts). worstCost is their sum.
 */
import { PLAN_PRICES, type Cycle, type Tier } from "@/lib/plan";
import { PAID_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { VISITS_INCLUDED } from "@/lib/traffic-rules";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { AUTOMATIC_AI_STORE_MICRO_USD } from "@/lib/ai-spend-policy";
import { uploadWorstCostMicroUsd } from "@/lib/upload-budget-policy";
import { PROVIDER_FEES, MOST_CORRECT_READING, chargedOf, providerFeeCents, receivingOf } from "@/lib/receiving-costs";
import { visitCost } from "./traffic-cost";
import { COST_LINES, ORDER_COST, hourCost } from "./plan-cost-registry";
export { PER_PAYMENT_LINES, perPaymentCost } from "./plan-cost-registry";

export {
  GB, STORAGE_PER_GB, FILE_DELIVERY_PER_GB, STREAM_STORAGE_PER_GB, STREAM_DELIVERY_PER_GB, FETCHED_AHEAD, PER_EMAIL,
  ORDER_COMPUTE, ORDER_COST, TRANSACTIONAL, hourCost,
} from "./plan-cost-registry";

/** The automatic monthly AI ceiling of a plan, in dollars. */
export function aiCeilingUsd(tier: Tier): number {
  return AUTOMATIC_AI_STORE_MICRO_USD[tier] / 1_000_000;
}
/** Every upload operation a plan's monthly allowance can start, in dollars. */
export function uploadOpsUsd(tier: Tier): number {
  return uploadWorstCostMicroUsd(tier) / 1_000_000;
}

/**
 * What Stripe Billing takes of a subscription charge, on top of the card fee.
 * Kept as a name for the older sums that quote it; every fee is now the one
 * model of lib/receiving-costs.ts (6.6% + 30 cents at the dearer provider,
 * on the amount charged with the buyer's tax on top, and the remittance,
 * refund and dispute reserves).
 */
export const BILLING_RATE = PROVIDER_FEES.stripe.billingBps / 10_000;

/**
 * What reaches us for one month of a plan, after receiving it costs every
 * fee and reserve (lib/receiving-costs.ts, the non-tax receiving metadata): one monthly
 * charge, or a twelfth of the yearly one. Before 18 October 2026 this was
 * 2.9% + 0.7% + 30 cents on the price with no reserve, lighter than the
 * add-on's model in the same repository.
 */
export type Prices = Record<Tier, Record<Cycle, number>>;
export function netOf(tier: Tier, cycle: Cycle = "month", prices: Prices = PLAN_PRICES): number {
  const received = receivingOf(prices[tier][cycle], MOST_CORRECT_READING, true);
  const kept = (received.revenueCents - received.totalCents) / 100;
  return cycle === "year" ? kept / 12 : kept;
}

/** The dearer provider's fee on one charge of this many cents, on the amount charged, in dollars: what it keeps when the charge is refunded. */
export function providerFeeUsd(grossCents: number): number {
  return providerFeeCents(chargedOf(grossCents, MOST_CORRECT_READING), true) / 100;
}

/**
 * What one line on a renewal invoice keeps, as a share of its price: only the
 * percentages of the fee (on the amount charged), the remittance and the
 * reserves, no fixed fee.
 */
export function lineKeptShare(): number {
  const big = 1_000_000;
  const r = receivingOf(big, MOST_CORRECT_READING, false);
  return (r.revenueCents - r.totalCents) / big;
}

/** The hours of video a plan covers, all of them watched. */
export function videoCost(tier: Tier = "creator"): number {
  return PAID_VIDEO_HOURS[tier] * hourCost();
}

/** The visits a plan covers, all of them made, each by the heavy visitor a visit is costed as. */
export function visitsCost(tier: Tier): number {
  return VISITS_INCLUDED[tier] * visitCost();
}

/** The orders a plan covers, all of them made, each at the most an order costs. */
export function ordersCost(tier: Tier): number {
  return ORDERS_INCLUDED[tier] * ORDER_COST;
}

/** Each line of a plan's worst month, by its id in tests/plan-cost-registry.ts. */
export function worstLines(tier: Tier): Record<string, number> {
  return Object.fromEntries(COST_LINES.map((line) => [line.id, line.monthlyUsd(tier)]));
}

/** Everything one store on this plan can run up in a month, at every limit at once. */
export function worstCost(tier: Tier): number {
  return COST_LINES.reduce((sum, line) => sum + line.monthlyUsd(tier), 0);
}
