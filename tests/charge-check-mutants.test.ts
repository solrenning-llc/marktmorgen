/**
 * Mutation testing of lib/charge-check.ts (Claude 7, 13/11/2026): each case below
 * kills a mutant that survived tests/charge-check.test.ts and the read-evidence
 * test. An unreadable shape must decide "unread" or "unproven", never throw or
 * pass as a correct charge, and a refund of the excess must use the highest price
 * the subscription was sold at.
 */
import { decideCharge, type ChargeContext } from "@/lib/charge-check";
import { done, is, part } from "./check";

const DAY = 86400;
const start = 1_790_000_000;
const month = { start, end: start + 30 * DAY };
const price = 6900;

function context(over: Partial<ChargeContext> = {}): ChargeContext {
  return {
    currency: "usd",
    allowedUnitCents: () => [price],
    chargeableAt: () => true,
    otherPaidInvoice: () => null,
    prorationExplained: () => true,
    oneOffExplained: () => true,
    refundedCents: 0,
    disputed: false,
    ...over,
  };
}

function planLine(unit: number, period: unknown = month, extra: Record<string, unknown> = {}) {
  return {
    object: "line_item",
    amount: unit,
    subtotal: unit,
    currency: "usd",
    parent: { type: "subscription_item_details", subscription_item_details: { proration: false, subscription: "sub_MT1" } },
    period,
    pricing: { type: "price_details", price_details: { price: "price_MT1" }, unit_amount_decimal: String(unit) },
    quantity_decimal: "1",
    ...extra,
  };
}

function invoice(lines: unknown, over: Record<string, unknown> = {}, sum = price) {
  return {
    id: "in_MT1",
    object: "invoice",
    status: "paid",
    currency: "usd",
    amount_paid: sum,
    amount_overpaid: 0,
    post_payment_credit_notes_amount: 0,
    subtotal: sum,
    total: sum,
    status_transitions: { paid_at: start + 60 },
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_MT1" } },
    lines: { object: "list", has_more: false, data: lines },
    ...over,
  };
}

const unreadablePlan = { kind: "unproven", reasons: ["a plan line that cannot be read"], refundCents: price };

part("Period lengths at the edges of a month and a year");
is("a 31-day month is a month", decideCharge(invoice([planLine(price, { start, end: start + 31 * DAY })]), context()), { kind: "ok" });
const yearly = context({ allowedUnitCents: (_s, interval) => (interval === "year" ? [price] : []) });
is("a 366-day leap year is a year", decideCharge(invoice([planLine(price, { start, end: start + 366 * DAY })]), yearly), { kind: "ok" });
is("a 14-day period is neither", decideCharge(invoice([planLine(price, { start, end: start + 14 * DAY })]), context()), unreadablePlan);
is("a period start written as text is unreadable", decideCharge(invoice([planLine(price, { start: String(start), end: start + 30 * DAY })]), context()), unreadablePlan);
is("a period end written as text is unreadable", decideCharge(invoice([planLine(price, { start, end: String(start + 30 * DAY) })]), context()), unreadablePlan);

part("A unit amount that is not text is unreadable, never a crash");
is("unit amount as a number", decideCharge(invoice([planLine(price, month, { pricing: { type: "price_details", unit_amount_decimal: price } })]), context()), unreadablePlan);
is("pricing of another type", decideCharge(invoice([planLine(price, month, { pricing: { type: "other_details", unit_amount_decimal: String(price) } })]), context()), unreadablePlan);

part("Amounts and lists that cannot be read");
is("overpaid above what was paid", decideCharge(invoice([planLine(price)], { amount_overpaid: price + 1 }), context()), { kind: "unread", reason: "amounts unreadable" });
is("lines that are not a list", decideCharge(invoice({ not: "a list" }), context()), { kind: "unread", reason: "lines unreadable" });
is("no lines object at all", decideCharge(invoice([], { lines: null }), context()), { kind: "unread", reason: "lines unreadable" });

part("Lines that cannot be placed are doubts, never crashes");
is("a null line", decideCharge(invoice([planLine(price), null]), context()), { kind: "unproven", reasons: ["a line is unreadable"], refundCents: price });
is("a line with no parent", decideCharge(invoice([planLine(price), { ...planLine(0), parent: null }]), context()), { kind: "unproven", reasons: ["a line with no known parent"], refundCents: price });
const oneOff = { ...planLine(500), parent: { type: "invoice_item_details", invoice_item_details: { invoice_item: "ii_MT1", proration: false } } };
is("a one-off line the records cannot explain", decideCharge(invoice([planLine(price), oneOff]), context({ oneOffExplained: () => null })), { kind: "unproven", reasons: ["a one-off line with no record"], refundCents: price });
is("a one-off line that reads like a plan line keeps its own reason", decideCharge(invoice([planLine(price), { ...oneOff, pricing: { type: "price_details", unit_amount_decimal: String(price) }, subtotal: price }]), context({ oneOffExplained: () => false })), { kind: "unproven", reasons: ["a one-off line with no record"], refundCents: price });
const loose = { ...planLine(price), parent: { subscription_item_details: { proration: false, subscription: "sub_MT1" } } };
is("a plan line on an invoice with no subscription", decideCharge(invoice([loose], { parent: null }), context()), { kind: "unproven", reasons: ["a plan line that does not belong to the invoice's subscription"], refundCents: price });

part("The excess is measured from the highest price sold");
const two = context({ allowedUnitCents: () => [4900, 6900] });
is("above the higher of two prices: only the difference to it", decideCharge(invoice([planLine(7400)], {}, 7400), two), { kind: "wrong", reasons: ["charged above the price this plan was sold at"], refundCents: 500 });

done();
