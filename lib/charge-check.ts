/**
 * 569 [NC1], unit 5 (first part): the decision the daily charge check makes
 * about one paid invoice on Marktmorgen's own Stripe account.
 *
 * Pure: it reads only what it is handed and calls nothing. Nothing runs it
 * yet; the cron that reads Stripe and the refunds of unit 6 come next
 * (docs/billing-correctness.md, "Design of units 5 and 6").
 *
 * The invoice is read in the shape of Stripe API version 2025-03-31.basil and
 * later (the caller must pin one): a line carries no `price`, its unit amount
 * is `pricing.unit_amount_decimal` and its parent says whether it is a
 * proration ("The Invoice Line Item object", read 30 Oct 2026). A shape this
 * file does not recognize is never "ok": it is "unread" or "unproven".
 */

export type ChargeDecision =
  | { kind: "not_charged" }
  | { kind: "unread"; reason: string }
  | { kind: "ok" }
  | { kind: "wrong"; reasons: string[]; refundCents: number }
  | { kind: "unproven"; reasons: string[]; refundCents: number };

export type ChargeContext = {
  /** The currency the plan was shown in. */
  currency: string;
  /**
   * The unit amounts, in cents, THIS subscription may be charged for a full
   * period of this length: the price it was sold at, or a later price it was
   * told of in time. Never every published or legacy price at once.
   */
  allowedUnitCents: (subscription: string, interval: "month" | "year") => readonly number[];
  /** Whether the subscription was still to be charged at this time (not ended, closed, paused or a lapsed trial); null when the records cannot say. */
  chargeableAt: (subscription: string, paidAt: number) => boolean | null;
  /** The earliest OTHER paid invoice for this subscription and period start, with the cents it still keeps (paid less refunds and credit notes), or null. */
  otherPaidInvoice: (subscription: string, periodStart: number, invoiceId: string) => { id: string; paidAt: number; keptCents: number } | null;
  /** Whether this proration line's amount is the one a plan switch on record makes; null when unknown. */
  prorationExplained: (invoiceId: string, line: Record<string, unknown>) => boolean | null;
  /** Whether a one-off line (captions, usage) carries a key and amount the store's record holds; null when unknown. */
  oneOffExplained: (line: Record<string, unknown>) => boolean | null;
  /** Cents already refunded on this invoice's payments, all of them; null when they could not be read. */
  refundedCents: number | null;
  /** Whether any payment of this invoice is or was disputed; null when it could not be read. */
  disputed: boolean | null;
};

const DAY = 24 * 60 * 60;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A whole number of cents written as Stripe's decimal string, or null for anything else. */
function wholeCents(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(\.0+)?$/.test(value)) return null;
  const n = Number(value.split(".")[0]);
  return Number.isSafeInteger(n) ? n : null;
}

/** The full period a subscription line covers, by its length; null for anything else. */
function intervalOf(period: Record<string, unknown> | null): "month" | "year" | null {
  const start = period?.start;
  const end = period?.end;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return null;
  const days = (end - start) / DAY;
  if (days >= 28 && days <= 31) return "month";
  if (days >= 365 && days <= 366) return "year";
  return null;
}

function subscriptionOf(invoice: Record<string, unknown>): string | null {
  const details = record(record(invoice.parent)?.subscription_details);
  const id = details?.subscription;
  return typeof id === "string" && id.startsWith("sub_") ? id : null;
}

/** What one paid invoice should have been, against what it was. */
export function decideCharge(invoiceInput: unknown, context: ChargeContext): ChargeDecision {
  const invoice = record(invoiceInput);
  if (!invoice || typeof invoice.id !== "string") return { kind: "unread", reason: "not an invoice" };
  if (invoice.status !== "paid") return { kind: "not_charged" };
  const paidRaw = cents(invoice.amount_paid);
  const subtotal = cents(invoice.subtotal);
  const credited = cents(invoice.post_payment_credit_notes_amount);
  const overpaid = cents(invoice.amount_overpaid);
  if (paidRaw === null || subtotal === null || credited === null || overpaid === null || overpaid > paidRaw) {
    return { kind: "unread", reason: "amounts unreadable" };
  }
  // An amount paid above what was due is not ours to refund: Stripe credits it
  // to the customer's balance (`amount_overpaid`, "The Invoice object").
  const paid = paidRaw - overpaid;
  if (paid === 0) return { kind: "not_charged" };
  const paidAt = record(invoice.status_transitions)?.paid_at;
  if (typeof paidAt !== "number") return { kind: "unread", reason: "paid time unreadable" };
  const lines = record(invoice.lines);
  if (!lines || !Array.isArray(lines.data)) return { kind: "unread", reason: "lines unreadable" };
  if (lines.has_more !== false) return { kind: "unread", reason: "lines not read whole" };
  if (context.refundedCents === null) return { kind: "unread", reason: "refunds unreadable" };
  // A disputed charge is the card network's to settle; a refund on top of it pays twice.
  if (context.disputed !== false) return { kind: "unread", reason: context.disputed ? "disputed" : "disputes unreadable" };
  // What is still with us: neither refunded nor already credited back by a credit note.
  const left = Math.max(0, paid - credited - context.refundedCents);

  const wrong: string[] = [];
  const unproven: string[] = [];
  let excess = 0;
  let whole = false;
  let extraLines = 0;

  if (String(invoice.currency) !== context.currency) {
    wrong.push("charged in another currency than the one shown");
    whole = true;
  }

  if (lines.data.length === 0) unproven.push("no lines");
  const subscription = subscriptionOf(invoice);
  if (subscription) {
    const allowed = context.chargeableAt(subscription, paidAt);
    if (allowed === false) {
      wrong.push("charged after the plan was meant to stop");
      whole = true;
    } else if (allowed === null) {
      unproven.push("cannot tell whether the plan was still to be charged");
    }
  }

  const periodsSeen = new Set<number>();
  for (const raw of lines.data) {
    const line = record(raw);
    if (!line) {
      unproven.push("a line is unreadable");
      continue;
    }
    if (line.currency !== invoice.currency) unproven.push("a line in another currency");
    const parent = record(line.parent);
    const item = record(parent?.subscription_item_details) ?? record(parent?.invoice_item_details);
    if (!item) {
      unproven.push("a line with no known parent");
      continue;
    }
    const lineSubscription = typeof item.subscription === "string" ? item.subscription : null;
    if (parent?.type === "subscription_item_details" && (!subscription || lineSubscription !== subscription)) {
      unproven.push("a plan line that does not belong to the invoice's subscription");
      continue;
    }
    if (item.proration === true) {
      const explained = context.prorationExplained(invoice.id, line);
      if (explained !== true) unproven.push("a proration that no plan switch on record explains");
      continue;
    }
    if (parent?.type === "invoice_item_details") {
      const explained = context.oneOffExplained(line);
      if (explained !== true) unproven.push("a one-off line with no record");
      continue;
    }
    const pricing = record(line.pricing);
    const unit = wholeCents(pricing?.unit_amount_decimal);
    const period = record(line.period);
    const interval = intervalOf(period);
    const one = typeof line.quantity_decimal === "string" ? /^1(\.0+)?$/.test(line.quantity_decimal) : line.quantity === 1;
    // Its amount before discounts must be its unit amount: anything else is not a plain plan line.
    if (pricing?.type !== "price_details" || unit === null || !one || !interval || line.subtotal !== unit) {
      unproven.push("a plan line that cannot be read");
      continue;
    }
    if (!subscription) {
      unproven.push("a plan line that does not belong to the invoice's subscription");
      continue;
    }
    const start = period?.start as number;
    if (periodsSeen.has(start)) {
      wrong.push("the same period charged twice on one invoice");
      extraLines += unit;
      continue;
    }
    periodsSeen.add(start);
    const other = context.otherPaidInvoice(subscription, start, invoice.id);
    // Of two paid invoices for one period the earlier is kept (ties: the lower id).
    if (other && other.keptCents > 0 && (other.paidAt < paidAt || (other.paidAt === paidAt && other.id < invoice.id))) {
      wrong.push("the same period was already paid");
      whole = true;
    }
    const prices = context.allowedUnitCents(subscription, interval);
    if (prices.includes(unit)) continue;
    const highest = prices.length ? Math.max(...prices) : null;
    if (highest !== null && unit > highest) {
      wrong.push("charged above the price this plan was sold at");
      excess += unit - highest;
    } else {
      unproven.push("a plan price this subscription was not sold at");
    }
  }

  // The share of what was paid that the excess and extra lines are, tax added on top included, rounded once.
  const share = (base: number) => (base === 0 ? 0 : subtotal > 0 ? Math.ceil((base * paid) / subtotal) : paid);
  const over = share(excess + extraLines);

  if (wrong.length) {
    // A doubt alongside a proven error is still a doubt: the whole is refunded.
    const refundCents = whole || unproven.length ? left : Math.min(left, over);
    return { kind: "wrong", reasons: [...new Set([...wrong, ...unproven])], refundCents };
  }
  if (unproven.length) return { kind: "unproven", reasons: [...new Set(unproven)], refundCents: left };
  return { kind: "ok" };
}
