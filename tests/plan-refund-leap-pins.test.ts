/**
 * Time safety of the yearly plan refund (lib/plan-refund-rules.ts): how many of a yearly period's months have started
 * decides how much of a yearly payment is given back, so the month steps must follow Stripe's billing anchor across
 * a leap day and a year end exactly as they do across Jan 31 (tests/plan-refund-rules.test.ts). UTC throughout, so the
 * answer never depends on the server's time zone or a daylight-saving change. Pure values; nothing reaches Stripe.
 */
import { addMonthsLikeStripe, monthsStarted, planRefund, type PlanRefundInput } from "@/lib/plan-refund-rules";
import { done, is, part } from "./check";

const iso = (s: number) => new Date(s * 1000).toISOString();
const at = (y: number, m: number, d: number, h = 15) => Date.UTC(y, m, d, h, 0, 0) / 1000;

part("The anchor across a leap year");
const JAN31_2028 = at(2028, 0, 31);
is("Jan 31, 2028 + 1 month is Feb 29 (a leap year has the day)", iso(addMonthsLikeStripe(JAN31_2028, 1)), "2028-02-29T15:00:00.000Z");
is("and + 2 months is back on the 31st", iso(addMonthsLikeStripe(JAN31_2028, 2)), "2028-03-31T15:00:00.000Z");
const LEAP = at(2028, 1, 29);
is("Feb 29, 2028 + 1 month is Mar 29", iso(addMonthsLikeStripe(LEAP, 1)), "2028-03-29T15:00:00.000Z");
is("Feb 29, 2028 + 12 months is Feb 28, 2029 (no Feb 29 that year)", iso(addMonthsLikeStripe(LEAP, 12)), "2029-02-28T15:00:00.000Z");
is("Feb 29, 2028 + 48 months is Feb 29, 2032", iso(addMonthsLikeStripe(LEAP, 48)), "2032-02-29T15:00:00.000Z");
is("Nov 30, 2027 + 3 months is Feb 29, 2028", iso(addMonthsLikeStripe(at(2027, 10, 30), 3)), "2028-02-29T15:00:00.000Z");

part("The anchor across a year end");
const DEC31 = at(2026, 11, 31, 23);
is("Dec 31, 2026 23:00 + 1 month is Jan 31, 2027 23:00", iso(addMonthsLikeStripe(DEC31, 1)), "2027-01-31T23:00:00.000Z");
is("and + 2 months is Feb 28, 2027 23:00", iso(addMonthsLikeStripe(DEC31, 2)), "2027-02-28T23:00:00.000Z");
is("and + 14 months is Feb 29, 2028 23:00", iso(addMonthsLikeStripe(DEC31, 14)), "2028-02-29T23:00:00.000Z");

part("Months started in a yearly period that holds Feb 29");
is("Jan 31, 2028 period: Feb 29 14:59 still one month started", monthsStarted(JAN31_2028, at(2028, 1, 29, 14) + 59 * 60), 1);
is("Feb 29 15:00: two", monthsStarted(JAN31_2028, at(2028, 1, 29)), 2);
is("a period from Feb 29, 2028: the last second before Jan 29, 2029 is eleven", monthsStarted(LEAP, at(2029, 0, 29) - 1), 11);
is("Jan 29, 2029: all twelve", monthsStarted(LEAP, at(2029, 0, 29)), 12);

part("The yearly refund those months give");
const yearly = (nowSeconds: number): PlanRefundInput => ({
  cycle: "year",
  firstPayment: false,
  periodStartSeconds: JAN31_2028,
  monthlyCents: 6_900,
  nowSeconds,
  charge: {
    currency: "usd",
    succeeded: true,
    amountCents: 69_000,
    invoiceTotalCents: 69_000,
    billingReason: "subscription_cycle",
    refundedCents: 0,
    taxCents: 0,
    feeCents: 2_100,
    feeCurrency: "usd",
    paidAtSeconds: JAN31_2028,
    disputeStatus: null,
    disputedCents: null,
  },
});
// $690 a year at $69 a month: one month kept is $621 back less the $21 fee, two months kept is $552 less the fee.
is("on Feb 29 at 14:59, one month kept", planRefund(yearly(at(2028, 1, 29) - 60)), { kind: "unstarted_months", cents: 60_000, monthsKept: 1 });
is("on Feb 29 at 15:00, the second month has started", planRefund(yearly(at(2028, 1, 29))), { kind: "unstarted_months", cents: 53_100, monthsKept: 2 });
is("with tax on top, the tax of the unstarted months comes back, rounded down", planRefund({ ...yearly(at(2028, 1, 29)), charge: { ...yearly(0).charge, amountCents: 75_900, invoiceTotalCents: 75_900, taxCents: 6_900 } }), { kind: "unstarted_months", cents: 53_100 + 5_520, monthsKept: 2 });

done();
