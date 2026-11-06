/**
 * 232 [CA1] unit 6: what the plan's refund policy gives back is never more
 * than what was paid.
 *
 * app/refunds/page.tsx promises (sections 2, 3 and 5):
 *   - the first payment, refunded in full when asked within REFUND_DAYS;
 *   - a yearly payment, at any time, minus the months that have started at
 *     the plan's monthly price and minus Stripe's card fee on that payment;
 *   - nothing else (a monthly renewal, a switch charge, any later charge).
 *
 * The rule here is pure: it reads the charge as Stripe reports it (the amount
 * actually taken, so already net of coupons, discounts and customer balance;
 * what was already refunded; the dispute's status; the fee) and answers how
 * many cents a refund may be, or why there is none, or that it cannot tell
 * yet. Nothing here calls Stripe; 305 [SY1] builds the button on it.
 */
import { readFileSync } from "node:fs";
import { planRefund, monthsStarted, addMonthsLikeStripe, type PlanRefundInput } from "@/lib/plan-refund-rules";
import { REFUND_DAYS } from "@/lib/plan";
import { done, is, part } from "./check";

const DAY = 86_400;
const T0 = Date.UTC(2026, 0, 31, 15, 0, 0) / 1000; // Jan 31, 2026, 15:00 UTC

function base(over: Partial<PlanRefundInput> = {}, charge: Partial<PlanRefundInput["charge"]> = {}): PlanRefundInput {
  return {
    cycle: "month",
    firstPayment: true,
    periodStartSeconds: T0,
    monthlyCents: 4_900,
    nowSeconds: T0 + 3 * DAY,
    ...over,
    charge: {
      currency: "usd",
      succeeded: true,
      amountCents: 4_900,
      invoiceTotalCents: charge.amountCents ?? 4_900,
      billingReason: "subscription_create",
      refundedCents: 0,
      taxCents: 0,
      feeCents: 172,
      feeCurrency: "usd",
      paidAtSeconds: T0,
      disputeStatus: null,
      disputedCents: null,
      ...charge,
    },
  };
}

part("First payment, within the window: the whole payment, never more than was taken");
{
  is("in full", planRefund(base()), { kind: "guarantee", cents: 4_900 });
  is("on the last second of the window", planRefund(base({ nowSeconds: T0 + REFUND_DAYS * DAY })).kind, "guarantee");
  is("one second late: nothing on a monthly payment", planRefund(base({ nowSeconds: T0 + REFUND_DAYS * DAY + 1 })), { kind: "none", reason: "outside_window" });
  is("no card fee taken from the guarantee", planRefund(base({}, { feeCents: 999 })), { kind: "guarantee", cents: 4_900 });
  is("fee not read yet does not hold the guarantee back", planRefund(base({}, { feeCents: null })), { kind: "guarantee", cents: 4_900 });
  is("a coupon: what was taken, not the list price", planRefund(base({}, { amountCents: 2_450 })), { kind: "guarantee", cents: 2_450 });
  is("tax shown on top comes back with it", planRefund(base({}, { amountCents: 5_390, taxCents: 490 })), { kind: "guarantee", cents: 5_390 });
  is("a partial refund already made: only the rest", planRefund(base({}, { refundedCents: 1_000 })), { kind: "guarantee", cents: 3_900 });
  is("fully refunded already: nothing", planRefund(base({}, { refundedCents: 4_900 })), { kind: "none", reason: "already_refunded" });
  is("over-refunded record: nothing, never negative", planRefund(base({}, { refundedCents: 5_000 })), { kind: "none", reason: "already_refunded" });
  is("a zero charge: nothing was paid", planRefund(base({}, { amountCents: 0 })), { kind: "none", reason: "nothing_paid" });
  is("a charge that did not succeed: nothing", planRefund(base({}, { succeeded: false })), { kind: "none", reason: "not_paid" });
  is("a customer balance paid part of the invoice: cannot tell", planRefund(base({}, { amountCents: 1_900, invoiceTotalCents: 4_900 })), { kind: "unknown", reason: "split_payment" });
  is("a first charge that was a switch, inside the window: still the guarantee", planRefund(base({}, { billingReason: "subscription_update" })), { kind: "guarantee", cents: 4_900 });
}

part("Not the first payment");
{
  is("a monthly renewal: nothing", planRefund(base({ firstPayment: false })), { kind: "none", reason: "renewal" });
  is("a switch charge: nothing (section 5)", planRefund(base({ firstPayment: false }, { billingReason: "subscription_update" })), { kind: "none", reason: "switch_charge" });
  is("a billing reason this code does not know: cannot tell", planRefund(base({ firstPayment: false }, { billingReason: "manual" })), { kind: "unknown", reason: "billing_reason" });
  is("a monthly renewal inside 30 days: still nothing", planRefund(base({ firstPayment: false, nowSeconds: T0 + DAY })), { kind: "none", reason: "renewal" });
}

part("Disputes: never a refund on top of what the bank returns");
{
  for (const status of ["warning_needs_response", "warning_under_review", "needs_response", "under_review", "something_new"]) {
    is(`open (${status}): nothing now`, planRefund(base({}, { disputeStatus: status })), { kind: "none", reason: "dispute_open" });
  }
  is("lost for part of the charge: cannot tell", planRefund(base({}, { disputeStatus: "lost", disputedCents: 1_000 })), { kind: "unknown", reason: "dispute_partial" });
  is("lost: the bank already returned it", planRefund(base({}, { disputeStatus: "lost", disputedCents: 4_900 })), { kind: "none", reason: "dispute_returned" });
  is("prevented: treated as already returned", planRefund(base({}, { disputeStatus: "prevented" })), { kind: "none", reason: "dispute_returned" });
  is("won: the policy applies again", planRefund(base({}, { disputeStatus: "won" })), { kind: "guarantee", cents: 4_900 });
  is("inquiry closed: the policy applies again", planRefund(base({}, { disputeStatus: "warning_closed" })), { kind: "guarantee", cents: 4_900 });
}

part("Yearly: months not started, at the monthly price, less Stripe's fee");
{
  const yin = (over: Partial<PlanRefundInput> = {}, charge: Partial<PlanRefundInput["charge"]> = {}) =>
    base({ cycle: "year", firstPayment: false, ...over }, { amountCents: 49_000, feeCents: 1_451, billingReason: "subscription_cycle", ...charge });
  const year = (over: Partial<PlanRefundInput> = {}, charge: Partial<PlanRefundInput["charge"]> = {}) => planRefund(yin(over, charge));
  // Second month (refund page's own example): two months kept and the fee.
  const second = year({ nowSeconds: T0 + 31 * DAY });
  is("second month: 2 kept", second, { kind: "unstarted_months", cents: 49_000 - 2 * 4_900 - 1_451, monthsKept: 2 });
  is("first month (renewal, any time): 1 kept", year({ nowSeconds: T0 + 40 * 60 }), { kind: "unstarted_months", cents: 49_000 - 4_900 - 1_451, monthsKept: 1 });
  is("first yearly payment within 30 days: the guarantee instead", year({ firstPayment: true, nowSeconds: T0 + 10 * DAY }), { kind: "guarantee", cents: 49_000 });
  is("first yearly payment after 30 days: months", year({ firstPayment: true, nowSeconds: T0 + 45 * DAY }).kind, "unstarted_months");
  is("all twelve started: nothing", year({ nowSeconds: T0 + 340 * DAY }), { kind: "none", reason: "months_used" });
  is("a coupon so large the months kept cover it: nothing, never negative", year({ nowSeconds: T0 + 200 * DAY }, { amountCents: 20_000 }), { kind: "none", reason: "months_used" });
  is("a switch charge on a yearly plan (maybe the yearly payment itself): cannot tell, never a silent no", year({ nowSeconds: T0 + 40 * DAY }, { amountCents: 76_400, billingReason: "subscription_update" }), { kind: "unknown", reason: "switch_yearly" });
  is("a debit balance (charge above the invoice total): cannot tell", year({ nowSeconds: T0 + 31 * DAY }, { amountCents: 50_000, invoiceTotalCents: 49_000 }), { kind: "unknown", reason: "split_payment" });
  is("fee in another currency than the charge: cannot tell", year({ nowSeconds: T0 + 31 * DAY }, { feeCurrency: "brl", feeCents: 7_800 }), { kind: "unknown", reason: "currency" });
  is("month 9 with a fee larger than the month left: the fee, not the months", year({ nowSeconds: T0 + 250 * DAY }, { feeCents: 5_000 }), { kind: "none", reason: "fee_kept" });
  is("tax with a partial refund: the total never passes the policy", year({ nowSeconds: T0 + 31 * DAY }, { amountCents: 53_917, taxCents: 4_917, refundedCents: 5_000 }), { kind: "unstarted_months", cents: 39_200 + Math.floor((4_917 * 39_200) / 49_000) - 1_451 - 5_000, monthsKept: 2 });
  is("fee not read yet: cannot tell", year({ nowSeconds: T0 + 31 * DAY }, { feeCents: null }), { kind: "unknown", reason: "fee_unread" });
  is("monthly price unknown: cannot tell", year({ nowSeconds: T0 + 31 * DAY, monthlyCents: null }), { kind: "unknown", reason: "monthly_price_unknown" });
  is("charged in another currency: cannot tell", year({ nowSeconds: T0 + 31 * DAY }, { currency: "eur" }), { kind: "unknown", reason: "currency" });
  // Tax on top: the part refunded takes its share of the tax back, rounded down.
  const taxed = year({ nowSeconds: T0 + 31 * DAY }, { amountCents: 53_917, taxCents: 4_917 });
  const preTax = 49_000 - 2 * 4_900;
  is("tax comes back for the part refunded", taxed, { kind: "unstarted_months", cents: preTax + Math.floor((4_917 * preTax) / 49_000) - 1_451, monthsKept: 2 });
  // Already partly refunded: the total given back never passes the policy's figure.
  const policy = 49_000 - 2 * 4_900 - 1_451;
  is("a partial refund counts against the policy's figure", year({ nowSeconds: T0 + 31 * DAY }, { refundedCents: 10_000 }), { kind: "unstarted_months", cents: policy - 10_000, monthsKept: 2 });
  is("refunded past the policy's figure: nothing more", year({ nowSeconds: T0 + 31 * DAY }, { refundedCents: policy }), { kind: "none", reason: "already_refunded" });
  is("a disputed yearly payment: nothing", year({ nowSeconds: T0 + 31 * DAY }, { disputeStatus: "needs_response" }), { kind: "none", reason: "dispute_open" });
}

part("Never more than was taken, whatever the input (10,000 random cases)");
{
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
  let bad = 0;
  for (let i = 0; i < 10_000; i++) {
    const amount = rnd(100_000);
    const input = base(
      { cycle: rnd(2) ? "year" : "month", firstPayment: rnd(2) === 1, monthlyCents: rnd(10) ? rnd(9_000) : null, nowSeconds: T0 + rnd(400 * DAY) },
      { billingReason: ["subscription_create", "subscription_cycle", "subscription_update", "manual"][rnd(4)], amountCents: amount, refundedCents: rnd(3) ? 0 : rnd(amount + 1), taxCents: rnd(Math.floor(amount / 5) + 1), feeCents: rnd(10) ? rnd(3_000) : null, disputeStatus: rnd(8) ? null : ["won", "lost", "needs_response"][rnd(3)] },
    );
    const out = planRefund(input);
    const c = input.charge;
    if ("cents" in out && (out.cents <= 0 || !Number.isSafeInteger(out.cents) || out.cents + c.refundedCents > c.amountCents)) bad += 1;
    if (out.kind === "unstarted_months") {
      // Written apart from the rule: what section 3 gives back in total.
      const started = monthsStarted(input.periodStartSeconds, input.nowSeconds);
      const pre = c.amountCents - c.taxCents;
      const back = Math.max(0, pre - started * (input.monthlyCents ?? 0));
      const total = back + Math.floor((c.taxCents * back) / pre) - (c.feeCents ?? 0);
      if (out.cents + c.refundedCents > total) bad += 1;
    }
  }
  is("no refund above what is left of the charge or the policy's total, none zero or fractional", bad, 0);
}

part("Bad data is never read as money");
{
  for (const [what, charge] of [["negative amount", { amountCents: -1 }], ["fractional amount", { amountCents: 10.5 }], ["NaN refunded", { refundedCents: Number.NaN }], ["tax above amount", { taxCents: 9_999 }], ["negative fee", { feeCents: -5 }]] as const) {
    is(what, planRefund(base({}, charge as Partial<PlanRefundInput["charge"]>)), { kind: "unknown", reason: "unreadable" });
  }
  is("a yearly monthly price that is not money", planRefund(base({ cycle: "year", firstPayment: false, monthlyCents: -3, nowSeconds: T0 + 40 * DAY }, { amountCents: 49_000 })), { kind: "unknown", reason: "unreadable" });
}

part("Months start on Stripe's billing anchor");
{
  const iso = (s: number) => new Date(s * 1000).toISOString();
  is("Jan 31 + 1 month is Feb 28", iso(addMonthsLikeStripe(T0, 1)), "2026-02-28T15:00:00.000Z");
  is("Jan 31 + 2 months is Mar 31", iso(addMonthsLikeStripe(T0, 2)), "2026-03-31T15:00:00.000Z");
  is("before the period: none started", monthsStarted(T0, T0 - 1), 0);
  is("at its first second: one", monthsStarted(T0, T0), 1);
  is("Feb 28 14:59: still one", monthsStarted(T0, Date.UTC(2026, 1, 28, 14, 59) / 1000), 1);
  is("Feb 28 15:00: two", monthsStarted(T0, Date.UTC(2026, 1, 28, 15, 0) / 1000), 2);
  is("a year on: twelve, never more", monthsStarted(T0, T0 + 800 * DAY), 12);
}

part("The rule is the one the refund page states");
{
  const page = readFileSync("app/refunds/page.tsx", "utf8");
  is("the guarantee reads REFUND_DAYS", page.includes("({REFUND_DAYS}) days of the"), true);
  is("months kept at the monthly price", page.includes("the monthly price of that plan"), true);
  is("the card fee kept on a yearly refund", page.includes("card processing fee Stripe"), true);
  is("renewals refunded only inside the guarantee's days", page.includes("After the {REFUND_DAYS} days of section 2, a monthly renewal, a\n          charge made when you switch plans"), true);
  is("inside them, every payment for the same store since the first (owner, 31/10/2026 15h41; lib/plan-refund.ts)", page.includes("and in full every other payment for the same store&apos;s plan made\n          since then, within those days"), true);
  is("once per person, by email address or by card (lib/plan-refund.ts personPaidBefore)", page.includes("given once per person: a payment is not a first payment when the\n          same person, by email address or by card, has paid us before."), true);
  is("never that the creator's Stripe customers are untouched (closing stops the renewals sold there)", [/untouched/.test(page), page.includes("are stopped at Stripe, each at the end of the period already")], [false, true]);
}

done();
