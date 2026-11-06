import { decideCharge, type ChargeContext } from "@/lib/charge-check";
import { LEGACY_PLAN_PRICES, PLAN_PRICES } from "@/lib/plan";
import { done, is, part } from "./check";

const DAY = 86400;
const start = 1_790_000_000;
const month = { start, end: start + 30 * DAY };
const year = { start, end: start + 365 * DAY };

function context(over: Partial<ChargeContext> = {}): ChargeContext {
  return {
    currency: "usd",
    allowedUnitCents: (_subscription, interval) => [PLAN_PRICES.creator[interval]],
    chargeableAt: () => true,
    otherPaidInvoice: () => null,
    prorationExplained: () => true,
    oneOffExplained: () => true,
    refundedCents: 0,
    disputed: false,
    ...over,
  };
}

function planLine(unit: number, period = month, extra: Record<string, unknown> = {}) {
  return {
    object: "line_item",
    amount: unit,
    subtotal: unit,
    currency: "usd",
    parent: { type: "subscription_item_details", subscription_item_details: { proration: false, subscription: "sub_NC1" } },
    period,
    pricing: { type: "price_details", price_details: { price: "price_NC1" }, unit_amount_decimal: String(unit) },
    quantity_decimal: "1",
    ...extra,
  };
}

function invoice(lines: unknown[], over: Record<string, unknown> = {}) {
  const sum = lines.reduce<number>((n, l) => n + Number((l as { amount?: number }).amount ?? 0), 0);
  return {
    id: "in_NC1",
    object: "invoice",
    status: "paid",
    currency: "usd",
    amount_paid: sum,
    amount_due: sum,
    amount_overpaid: 0,
    post_payment_credit_notes_amount: 0,
    subtotal: sum,
    total: sum,
    billing_reason: "subscription_cycle",
    status_transitions: { paid_at: start + 60 },
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_NC1" } },
    lines: { object: "list", has_more: false, data: lines },
    ...over,
  };
}

const monthly = PLAN_PRICES.creator.month;
const yearly = PLAN_PRICES.creator.year;

part("A charge at the published price is correct");
is("monthly", decideCharge(invoice([planLine(monthly)]), context()), { kind: "ok" });
is("yearly", decideCharge(invoice([planLine(yearly, year)]), context()), { kind: "ok" });
const legacy = LEGACY_PLAN_PRICES[0].creator.month;
const onLegacy = context({ allowedUnitCents: () => [legacy] });
is("a legacy price the subscription started on", decideCharge(invoice([planLine(legacy)]), onLegacy), { kind: "ok" });
is("quantity written with decimals", decideCharge(invoice([planLine(monthly, month, { quantity_decimal: "1.000000000000" })]), context()), { kind: "ok" });
is("a 28-day February", decideCharge(invoice([planLine(monthly, { start, end: start + 28 * DAY })]), context()), { kind: "ok" });
is("overpaid: Stripe credits the balance, nothing to refund", decideCharge(invoice([planLine(monthly)], { amount_paid: monthly + 100, amount_due: monthly, amount_overpaid: 100 }), context()), { kind: "ok" });
is("an explained proration", decideCharge(invoice([planLine(monthly), { ...planLine(1234), parent: { type: "subscription_item_details", subscription_item_details: { proration: true, subscription: "sub_NC1" } } }]), context()), { kind: "ok" });

part("Nothing to decide");
is("an open invoice charged nothing", decideCharge(invoice([planLine(monthly)], { status: "open" }), context()), { kind: "not_charged" });
is("a trial's zero invoice", decideCharge(invoice([planLine(0)], { amount_paid: 0, amount_due: 0 }), context()), { kind: "not_charged" });

part("Proven wrong: refunded");
is("above the published price: the difference", decideCharge(invoice([planLine(monthly + 500)]), context()), { kind: "wrong", reasons: ["charged above the price this plan was sold at"], refundCents: 500 });
const taxed = invoice([planLine(monthly + 500)], { amount_paid: Math.round((monthly + 500) * 1.1), amount_due: Math.round((monthly + 500) * 1.1) });
is("the difference with its share of tax added on top", decideCharge(taxed, context()), { kind: "wrong", reasons: ["charged above the price this plan was sold at"], refundCents: Math.ceil((500 * taxed.amount_paid) / taxed.subtotal) });
is("charged after the plan was meant to stop: all of it", decideCharge(invoice([planLine(monthly)]), context({ chargeableAt: () => false })), { kind: "wrong", reasons: ["charged after the plan was meant to stop"], refundCents: monthly });
is("the same period paid twice: all of the second", decideCharge(invoice([planLine(monthly)]), context({ otherPaidInvoice: () => ({ id: "in_EARLIER", paidAt: start, keptCents: monthly }) })), { kind: "wrong", reasons: ["the same period was already paid"], refundCents: monthly });
is("another currency than shown: all of it", decideCharge(invoice([{ ...planLine(monthly), currency: "eur" }], { currency: "eur" }), context()), { kind: "wrong", reasons: ["charged in another currency than the one shown"], refundCents: monthly });
is("a legacy subscriber charged today's price: the difference", decideCharge(invoice([planLine(monthly)]), onLegacy), monthly > legacy ? { kind: "wrong", reasons: ["charged above the price this plan was sold at"], refundCents: monthly - legacy } : { kind: "unproven", reasons: ["a plan price this subscription was not sold at"], refundCents: monthly });
is("the same period twice on one invoice: the extra line", decideCharge(invoice([planLine(monthly), planLine(monthly)]), context()), { kind: "wrong", reasons: ["the same period charged twice on one invoice"], refundCents: monthly });
const first = context({ otherPaidInvoice: () => ({ id: "in_A", paidAt: start + 10, keptCents: monthly }) });
const second = context({ otherPaidInvoice: () => ({ id: "in_Z", paidAt: start + 600, keptCents: monthly }) });
is("of a duplicate pair, the later one is refunded whole", decideCharge(invoice([planLine(monthly)]), first), { kind: "wrong", reasons: ["the same period was already paid"], refundCents: monthly });
is("a tie refunds the higher id", decideCharge(invoice([planLine(monthly)]), context({ otherPaidInvoice: () => ({ id: "in_AAA", paidAt: start + 60, keptCents: monthly }) })).kind, "wrong");
is("not when the earlier one was already given back", decideCharge(invoice([planLine(monthly)]), context({ otherPaidInvoice: () => ({ id: "in_A", paidAt: start + 10, keptCents: 0 }) })), { kind: "ok" });
const overpaidWrong = invoice([planLine(monthly)], { amount_paid: monthly + 100, amount_due: monthly, amount_overpaid: 100 });
is("an overpayment is never refunded again on top of Stripe's credit", decideCharge(overpaidWrong, context({ chargeableAt: () => false })), { kind: "wrong", reasons: ["charged after the plan was meant to stop"], refundCents: monthly });
is("of a duplicate pair, the earlier one is kept", decideCharge(invoice([planLine(monthly)]), second), { kind: "ok" });
const tie = context({ otherPaidInvoice: () => ({ id: "in_ZZZ", paidAt: start + 60, keptCents: monthly }) });
is("a tie keeps the lower id", decideCharge(invoice([planLine(monthly)]), tie), { kind: "ok" });
const coupon = invoice([planLine(monthly + 1000)], { amount_paid: monthly, amount_due: monthly });
is("over-priced with a coupon: the excess's share of what was paid", decideCharge(coupon, context()), { kind: "wrong", reasons: ["charged above the price this plan was sold at"], refundCents: Math.ceil((1000 * monthly) / (monthly + 1000)) });

part("Already refunded, credited or disputed: never more than is left");
is("a credit note after payment is subtracted", decideCharge(invoice([planLine(monthly)], { post_payment_credit_notes_amount: 1500 }), context({ chargeableAt: () => false })), { kind: "wrong", reasons: ["charged after the plan was meant to stop"], refundCents: monthly - 1500 });
is("a disputed charge is left to the dispute", decideCharge(invoice([planLine(monthly)]), context({ chargeableAt: () => false, disputed: true })), { kind: "unread", reason: "disputed" });
is("disputes not read", decideCharge(invoice([planLine(monthly)]), context({ disputed: null })), { kind: "unread", reason: "disputes unreadable" });
is("partly refunded leaves the rest", decideCharge(invoice([planLine(monthly)]), context({ chargeableAt: () => false, refundedCents: 1000 })), { kind: "wrong", reasons: ["charged after the plan was meant to stop"], refundCents: monthly - 1000 });
is("fully refunded asks for nothing", decideCharge(invoice([planLine(monthly)]), context({ chargeableAt: () => false, refundedCents: monthly })), { kind: "wrong", reasons: ["charged after the plan was meant to stop"], refundCents: 0 });
is("the excess is capped at what is left", decideCharge(invoice([planLine(monthly + 500)]), context({ refundedCents: monthly + 300 })), { kind: "wrong", reasons: ["charged above the price this plan was sold at"], refundCents: 200 });

part("A doubt is never correct: treated as wrong, refunded whole");
is("a price that is not published", decideCharge(invoice([planLine(monthly - 1)]), context()), { kind: "unproven", reasons: ["a plan price this subscription was not sold at"], refundCents: monthly - 1 });
is("cannot tell whether the plan was to be charged", decideCharge(invoice([planLine(monthly)]), context({ chargeableAt: () => null })), { kind: "unproven", reasons: ["cannot tell whether the plan was still to be charged"], refundCents: monthly });
const proration = { ...planLine(99999), parent: { type: "subscription_item_details", subscription_item_details: { proration: true, subscription: "sub_NC1" } } };
let askedWith: unknown = null;
is("a proration the switch on record does not explain", decideCharge(invoice([proration]), context({ prorationExplained: (_id, line) => { askedWith = line; return false; } })).kind, "unproven");
is("the proration is judged with its own line and amount", (askedWith as { amount?: number } | null)?.amount, 99999);
is("a plan line of another subscription", decideCharge(invoice([planLine(monthly, month, { parent: { type: "subscription_item_details", subscription_item_details: { proration: false, subscription: "sub_OTHER" } } })]), context()).kind, "unproven");
is("a paid subscription invoice with no lines", decideCharge(invoice([], { amount_paid: 1000, subtotal: 0 }), context()).kind, "unproven");
is("a plan line naming no subscription", decideCharge(invoice([planLine(monthly, month, { parent: { type: "subscription_item_details", subscription_item_details: { proration: false } } })]), context()).kind, "unproven");
is("a plan line whose amount before discounts is not its unit", decideCharge(invoice([planLine(monthly, month, { subtotal: monthly * 2, amount: monthly * 2 })]), context()).kind, "unproven");
is("a plan line on an invoice with no subscription", decideCharge(invoice([planLine(monthly)], { parent: null }), context()).kind, "unproven");
is("a one-off line with no record", decideCharge(invoice([{ ...planLine(3500), parent: { type: "invoice_item_details", invoice_item_details: { proration: false } } }]), context({ oneOffExplained: () => null })).kind, "unproven");
is("a quantity of two", decideCharge(invoice([planLine(monthly, month, { quantity_decimal: "2" })]), context()).kind, "unproven");
is("a period that is neither a month nor a year", decideCharge(invoice([planLine(monthly, { start, end: start + 90 * DAY })]), context()).kind, "unproven");
is("the old shape with a top-level price is not read as correct", decideCharge(invoice([{ ...planLine(monthly), pricing: undefined, price: { unit_amount: monthly } }]), context()).kind, "unproven");
is("a line of another currency", decideCharge(invoice([{ ...planLine(monthly), currency: "eur" }]), context()).kind, "unproven");
const both = decideCharge(invoice([planLine(monthly + 500), planLine(monthly - 1, { start: start + 30 * DAY, end: start + 60 * DAY })]), context());
is("a proven excess beside a doubt refunds the whole", both, { kind: "wrong", reasons: ["charged above the price this plan was sold at", "a plan price this subscription was not sold at"], refundCents: monthly + 500 + monthly - 1 });

part("What it could not read is decided later, never correct and never refunded");
is("lines not read whole", decideCharge(invoice([planLine(monthly)], { lines: { has_more: true, data: [planLine(monthly)] } }), context()), { kind: "unread", reason: "lines not read whole" });
is("refunds not read", decideCharge(invoice([planLine(monthly)]), context({ refundedCents: null })), { kind: "unread", reason: "refunds unreadable" });
is("no paid time", decideCharge(invoice([planLine(monthly)], { status_transitions: {} }), context()), { kind: "unread", reason: "paid time unreadable" });
is("amounts that are not whole cents", decideCharge(invoice([planLine(monthly)], { amount_paid: 12.5 }), context()), { kind: "unread", reason: "amounts unreadable" });
is("credit notes missing", decideCharge(invoice([planLine(monthly)], { post_payment_credit_notes_amount: undefined }), context()), { kind: "unread", reason: "amounts unreadable" });
is("credit notes that cannot be read", decideCharge(invoice([planLine(monthly)], { post_payment_credit_notes_amount: "x" }), context()), { kind: "unread", reason: "amounts unreadable" });
is("not an invoice", decideCharge(null, context()), { kind: "unread", reason: "not an invoice" });

done();
