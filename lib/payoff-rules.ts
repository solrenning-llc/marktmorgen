/**
 * 381 [TB7], unit 1: paying off a payment plan early, the pure rule.
 *
 * A payment plan is a subscription on the creator's own Stripe account that
 * stops by itself after a fixed number of payments (lib/plans.ts gives it
 * that end). A buyer who wants to be done sooner may pay what is left at
 * once: exactly the payments still to come, never interest, never a fee,
 * never more than the plan would have taken.
 *
 * This file only decides, from facts already read, whether that can be
 * offered now and for how much. It reads nothing, writes nothing and calls
 * no provider, so it costs nothing; the buyer's page and the charge that
 * ends the plan come in later units and must take their facts from Stripe
 * (subscription, its latest invoice, its invoices, its refunds and
 * disputes) before calling payoffQuote.
 *
 * It refuses, closed, whenever the amount could be wrong or a second charge
 * could follow:
 *   - "owing": a payment is due, failing or still open; the automatic
 *     payment goes first, then the rest can be paid off;
 *   - "due_soon": the next payment is taken within PAYOFF_QUIET_SECONDS,
 *     so the payoff and Stripe's own charge could both go through;
 *   - "unsettled": the plan has not been given its end yet (lib/plans.ts),
 *     so the number of payments left is not fixed on Stripe;
 *   - "ended": nothing is left to pay;
 *   - "given_back": a payment was refunded or disputed, whose rules
 *     (lib/refunds.ts) come first;
 *   - "discounted": a discount means the payments left may not all be the
 *     same amount;
 *   - "paused": collection is paused (pause_collection), so what Stripe
 *     does with the next invoices is not the plan's plain schedule;
 *   - "scheduled": a subscription schedule is attached and may change the
 *     price, the quantity or the end on its own;
 *   - "update_pending": an update waits on a payment (pending_update) and
 *     would change the subscription once it is paid;
 *   - "customer_balance": the customer holds a credit or owes an amount on
 *     the creator's account, which Stripe applies to the next invoice, so
 *     the payoff charge and that invoice would not be what the words say;
 *   - "mismatch": two sources disagree (the payments counted from the dates
 *     and the paid invoices, the period Stripe is in and the one the dates
 *     say, the plan's end and the one it must have, the item and the
 *     invoice, more than one item or a quantity above one);
 *   - "too_large": above the largest single charge Stripe takes;
 *   - "not_plan": not a payment plan (a membership that ends by itself is
 *     not one; it is paid for time, not for a product already delivered);
 *   - "unknown": a fact is missing or malformed, the tax behavior included.
 *
 * The total is the payments left at the plan's own price. The words follow
 * the price's tax behavior, never the tax on the latest invoice: a price with
 * tax included says so and is all the buyer pays; a price with tax on top
 * says tax may be added, worked out again when the buyer pays, even when the
 * latest invoice carried none (a tax that starts to apply would otherwise be
 * hidden). A price whose tax behavior is not known (Stripe's "unspecified",
 * or not read) is refused.
 */
import { CURRENCIES, formatMoney } from "@/lib/money";
import { addPeriods } from "@/lib/plans";
import { MAX_PLAN_PAYMENTS, MIN_PLAN_PAYMENTS } from "@/lib/product-extras";

/** No payoff this close to the next automatic payment: Stripe makes the invoice when the period starts and takes it about an hour later, then retries. */
export const PAYOFF_QUIET_SECONDS = 2 * 86_400;

/** The largest amount Stripe takes in one charge, in the smallest unit of any currency. */
export const STRIPE_MAX_CHARGE = 99_999_999;

/** What the later units read from Stripe, already parsed. A missing number is NaN or null, never 0 taken as true. */
export type PayoffFacts = {
  /** The subscription's metadata[kind]: "plan" for a payment plan. */
  kind: string | undefined;
  /** metadata[plan_payments]: how many payments in all. */
  payments: number;
  /** metadata[plan_interval]: "week" or "month". */
  interval: string | undefined;
  /** subscription.status. */
  status: string;
  /** subscription.billing_cycle_anchor. */
  billingCycleAnchor: number;
  /** subscription.trial_end, or null. */
  trialEnd: number | null;
  /** subscription.cancel_at, or null when the plan has not been given its end. */
  cancelAt: number | null;
  /** The start of the period the latest payment covers. */
  currentPeriodStart: number;
  /** How many items the subscription has. */
  itemCount: number;
  /** The single item's quantity. */
  quantity: number;
  /** The single item's price, in the smallest unit. */
  unitAmountCents: number;
  /** The plan's currency, lower case as Stripe writes it. */
  currency: string;
  /** Whether any discount applies to the subscription or its customer. */
  discounted: boolean;
  /**
   * The subscription's latest invoice. periodStart is the subscription line's
   * own period (lines.data[0].period.start), not invoice.period_start, which
   * for a subscription invoice is the period before the one it bills.
   * taxCents is read so a malformed invoice refuses; it never decides the
   * tax words (taxBehavior does).
   */
  latestInvoice: { status: string; subtotalCents: number; taxCents: number; periodStart: number } | null;
  /** This subscription's invoices paid with an amount above zero. */
  paidInvoices: number;
  /** This subscription's invoices made and not yet paid, voided or uncollectible. */
  openInvoices: number;
  /** Whether any payment of the plan was refunded, in whole or in part, or disputed. */
  givenBack: boolean;
  /** The plan price's tax_behavior; "unknown" when not read or Stripe's "unspecified". */
  taxBehavior: "inclusive" | "exclusive" | "unknown";
  /** Whether subscription.pause_collection is set; null when not read. */
  paused: boolean | null;
  /** Whether subscription.schedule is set; null when not read. */
  scheduled: boolean | null;
  /** Whether subscription.pending_update is set; null when not read. */
  pendingUpdate: boolean | null;
  /** customer.balance on the creator's account, in the smallest unit: below zero a credit, above zero owed; NaN when not read. */
  customerBalanceCents: number;
  nowSeconds: number;
};

export type PayoffRefusal =
  | "owing"
  | "due_soon"
  | "unsettled"
  | "ended"
  | "given_back"
  | "discounted"
  | "paused"
  | "scheduled"
  | "update_pending"
  | "customer_balance"
  | "mismatch"
  | "too_large"
  | "not_plan"
  | "unknown";

export type PayoffQuote = {
  ok: true;
  /** Payments in all. */
  payments: number;
  /** Payments taken so far, the first one included. */
  paid: number;
  /** Payments still to come, the ones the payoff replaces. */
  remaining: number;
  /** One payment at the plan's own price: tax included when taxBehavior is "inclusive", before tax when "exclusive". */
  eachCents: number;
  /** What the buyer pays now, at the same tax behavior: remaining × each, nothing added. */
  totalCents: number;
  currency: string;
  /** When the next automatic payment would have been taken. */
  nextDueAt: number;
  /** The price's tax behavior, which decides the words: tax included, or tax on top worked out when the buyer pays. */
  taxBehavior: "inclusive" | "exclusive";
};

const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
const OWING = new Set(["past_due", "unpaid", "incomplete"]);
const ENDED = new Set(["canceled", "incomplete_expired"]);

/** Whether the rest of a payment plan can be paid off now, and for how much. */
export function payoffQuote(f: PayoffFacts): PayoffQuote | { ok: false; reason: PayoffRefusal } {
  const no = (reason: PayoffRefusal) => ({ ok: false as const, reason });
  if (f.kind !== "plan") return no("not_plan");
  if (!whole(f.payments) || f.payments < MIN_PLAN_PAYMENTS || f.payments > MAX_PLAN_PAYMENTS) return no("unknown");
  if (f.interval !== "week" && f.interval !== "month") return no("unknown");
  const interval = f.interval;
  if (ENDED.has(f.status)) return no("ended");
  if (OWING.has(f.status)) return no("owing");
  if (f.status !== "active") return no("unknown");
  if (!whole(f.nowSeconds) || !whole(f.billingCycleAnchor) || f.billingCycleAnchor <= 0) return no("unknown");
  if (f.trialEnd !== null && !whole(f.trialEnd)) return no("unknown");
  if (f.cancelAt !== null && !whole(f.cancelAt)) return no("unknown");
  if (!whole(f.currentPeriodStart) || !whole(f.paidInvoices) || f.paidInvoices < 0 || !whole(f.openInvoices) || f.openInvoices < 0) return no("unknown");
  const invoice = f.latestInvoice;
  if (!invoice || !whole(invoice.subtotalCents) || !whole(invoice.taxCents) || invoice.taxCents < 0 || !whole(invoice.periodStart)) return no("unknown");
  if (!whole(f.itemCount) || f.itemCount < 1 || !whole(f.quantity) || f.quantity < 1) return no("unknown");
  if (f.taxBehavior !== "inclusive" && f.taxBehavior !== "exclusive") return no("unknown");
  const taxBehavior = f.taxBehavior;
  if (typeof f.paused !== "boolean" || typeof f.scheduled !== "boolean" || typeof f.pendingUpdate !== "boolean") return no("unknown");
  if (!whole(f.customerBalanceCents)) return no("unknown");
  const rule = CURRENCIES.find((c) => c.code === f.currency);
  if (!rule) return no("unknown");
  if (!whole(f.unitAmountCents) || f.unitAmountCents < rule.minCharge || f.unitAmountCents > rule.maxPrice) return no("unknown");

  // A payment owed comes first: Stripe goes on retrying it, and a payoff on
  // top could take it twice.
  if (invoice.status !== "paid" || f.openInvoices > 0) return no("owing");
  if (f.givenBack) return no("given_back");
  if (f.discounted) return no("discounted");
  // Anything that lets Stripe charge something other than the plan's plain
  // next payment, or apply money to it, comes before the payoff.
  if (f.paused) return no("paused");
  if (f.scheduled) return no("scheduled");
  if (f.pendingUpdate) return no("update_pending");
  if (f.customerBalanceCents !== 0) return no("customer_balance");

  // The count starts at the first payment, after a trial when there was one,
  // exactly as lib/plans.ts counts the plan's end.
  const anchor = Math.max(f.billingCycleAnchor, f.trialEnd ?? 0);
  const end = addPeriods(anchor, interval, f.payments);
  if (f.cancelAt === null) return no("unsettled");
  if (f.cancelAt !== end) return no("mismatch");
  if (f.nowSeconds < anchor) return no("unknown");
  if (f.nowSeconds >= end) return no("ended");
  let paid = 1;
  while (paid < f.payments && addPeriods(anchor, interval, paid) <= f.nowSeconds) paid += 1;
  const remaining = f.payments - paid;
  if (remaining < 1) return no("ended");
  if (f.currentPeriodStart !== addPeriods(anchor, interval, paid - 1)) return no("mismatch");
  if (invoice.periodStart !== f.currentPeriodStart) return no("mismatch");
  if (f.paidInvoices !== paid) return no("mismatch");
  if (f.itemCount !== 1 || f.quantity !== 1) return no("mismatch");
  if (invoice.subtotalCents !== f.unitAmountCents) return no("mismatch");

  const nextDueAt = addPeriods(anchor, interval, paid);
  if (nextDueAt - f.nowSeconds < PAYOFF_QUIET_SECONDS) return no("due_soon");
  const totalCents = remaining * f.unitAmountCents;
  if (!whole(totalCents) || totalCents > STRIPE_MAX_CHARGE) return no("too_large");
  return { ok: true, payments: f.payments, paid, remaining, eachCents: f.unitAmountCents, totalCents, currency: f.currency, nextDueAt, taxBehavior };
}

/**
 * The sentence the buyer confirms before paying off. Only for the flow that
 * charges this total and then ends the plan, so no later payment is taken.
 */
export function payoffWords(quote: PayoffQuote): string {
  const total = formatMoney(quote.totalCents, quote.currency);
  const tax = quote.taxBehavior === "inclusive" ? ", tax included" : ", plus any tax, worked out when you pay";
  const head = quote.remaining === 1
    ? `Pay the last payment now: ${total}, the same as that payment`
    : `Pay the ${quote.remaining} payments left now: ${total} in all, the same as those payments`;
  return `${head}, with no interest or fee${tax}. No more payments are taken after this.`;
}
