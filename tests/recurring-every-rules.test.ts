/**
 * 609 [WP8], unit 1: billing every N weeks or months, the rules
 * (lib/recurring-every-rules.ts). What is checked:
 *
 *   - only every 1 or 2 weeks, or every 1, 2, 3 or 6 months; days and years once;
 *     every choice inside Stripe's three-year ceiling;
 *   - a typed count is read exactly, never rounded to a near one; a kept one
 *     that is not a choice is 1, as memberships were before;
 *   - the price line always says the exact interval, and with a count of 1 it
 *     is word for word today's line (lib/product-recurring.ts membershipPrice);
 *   - Stripe is sent the count only when it is not 1, and never a count the
 *     page did not say;
 *   - what cannot go with a count above 1 yet is refused with its reason;
 *   - the store's numbers already read a quarterly membership as a third of its
 *     price a month, never as the whole price a month.
 */
import { INTERVALS, membershipPrice, type Interval } from "@/lib/product-recurring";
import {
  EVERY_CHOICES,
  EVERY_PROBLEM_WORDS,
  STRIPE_MAX_EVERY,
  everyName,
  everyPriceLine,
  everyProblem,
  everyWords,
  isEvery,
  parseEvery,
  readEvery,
  stripeEveryFields,
} from "@/lib/recurring-every-rules";
import { monthly } from "@/lib/membership-numbers";
import { done, is, part } from "./check";

part("Which counts there are");
is("every 1 or 2 weeks, every 1, 2, 3 or 6 months, days and years once", EVERY_CHOICES, { day: [1], week: [1, 2], month: [1, 2, 3, 6], year: [1] });
is("every choice is inside Stripe's three-year ceiling", INTERVALS.every((i) => EVERY_CHOICES[i].every((n) => n >= 1 && n <= STRIPE_MAX_EVERY[i])), true);
is("Stripe's ceiling as it states it: 36 months, 156 weeks, 3 years", [STRIPE_MAX_EVERY.month, STRIPE_MAX_EVERY.week, STRIPE_MAX_EVERY.year], [36, 156, 3]);
is("a count that is not a choice is not one", [isEvery("month", 4), isEvery("week", 3), isEvery("year", 2), isEvery("month", "3"), isEvery("month", 3)], [false, false, false, false, true]);

part("A count as the editor sends it");
is("empty, absent or 0 is the interval itself", [readEvery("month", ""), readEvery("month", undefined), readEvery("month", null), readEvery("month", 0), readEvery("month", "0")], [1, 1, 1, 1, 1]);
is("a choice is kept, typed or as a number", [readEvery("month", "3"), readEvery("month", " 6 "), readEvery("week", 2)], [3, 6, 2]);
is("anything else is refused, never rounded to a near choice", [readEvery("month", "4"), readEvery("month", "3.5"), readEvery("month", 2.5), readEvery("month", "-3"), readEvery("month", "three"), readEvery("week", "3"), readEvery("year", 2), readEvery("month", [3])], ["every", "every", "every", "every", "every", "every", "every", "every"]);
is("a kept count that is not a choice is 1, as before WP8", [parseEvery("month", 3), parseEvery("month", 5), parseEvery("year", 2), parseEvery("month", undefined), parseEvery("month", "3")], [3, 1, 1, 1, 1]);

part("The words always say the exact interval");
is("every N in plain words", [everyWords("month", 3), everyWords("month", 6), everyWords("week", 2), everyWords("month", 1), everyWords("week", 1)], ["every 3 months", "every 6 months", "every 2 weeks", "a month", "a week"]);
is("and as a name in a list", [everyName("month", 3), everyName("week", 2), everyName("month", 1)], ["Every 3 months", "Every 2 weeks", "Monthly"]);
const base = { trialDays: 0, payments: 0 };
is("the price line: $90 every 3 months, never $90 a month", everyPriceLine({ interval: "month", count: 3, ...base }, "$90"), "$90 every 3 months");
is("with a free trial", everyPriceLine({ interval: "month", count: 3, trialDays: 7, payments: 0 }, "$90"), "7-day free trial, then $90 every 3 months");
is("with a set number of payments", everyPriceLine({ interval: "week", count: 2, trialDays: 0, payments: 4 }, "$40"), "4 payments of $40, one every 2 weeks");
const today: { interval: Interval; trialDays: number; payments: number }[] = [];
for (const interval of INTERVALS) for (const trialDays of [0, 7]) for (const payments of [0, 12]) today.push({ interval, trialDays, payments });
is("with a count of 1, word for word the line on sale today", today.every((r) => everyPriceLine({ ...r, count: 1 }, "$9") === membershipPrice(r, "$9")), true);
is("a count that is not a choice reads as 1, never as a schedule nobody chose", everyPriceLine({ interval: "month", count: 4, ...base }, "$9"), "$9 a month");

part("What Stripe is sent");
const at = "line_items[0][price_data][recurring]";
is("every 3 months: the interval and the count", stripeEveryFields(at, "month", 3), [[`${at}[interval]`, "month"], [`${at}[interval_count]`, "3"]]);
is("a count of 1: exactly what is sent today, no count", stripeEveryFields(at, "month", 1), [[`${at}[interval]`, "month"]]);
const refused = (interval: Interval, count: number) => {
  try {
    stripeEveryFields(at, interval, count);
    return false;
  } catch {
    return true;
  }
};
is("a count the page could not say is never sent", [refused("month", 4), refused("year", 2), refused("week", 3), refused("month", 0), refused("month", 3)], [true, true, true, true, false]);

part("What a count above 1 cannot go with yet");
is("nothing with a count of 1", everyProblem(1, { intro: { cents: 100 }, yearly: { cents: 9000 }, pauseOn: true, inTiers: true }), null);
is("an introductory price, a yearly option, a pause, plan switching: each refused by its reason", [
  everyProblem(3, { intro: { cents: 100 } }),
  everyProblem(3, { yearly: { cents: 9000 } }),
  everyProblem(3, { pauseOn: true }),
  everyProblem(2, { inTiers: true }),
  everyProblem(3, {}),
], ["intro", "yearly", "pause", "tiers", null]);
// A membership that ends after N payments is ended by lib/plans.ts counting N single intervals: with a count above 1 it
// would end before the last payment the page promised (independent review of 5818f21), so it is refused until the end counts too.
is("a set number of payments with a count above 1 is refused, and allowed with a count of 1", [everyProblem(2, { payments: 4 }), everyProblem(3, { payments: 12 }), everyProblem(1, { payments: 4 }), everyProblem(3, { payments: 0 })], ["payments", "payments", null, null]);
is("each refusal says what to do, in plain words", Object.values(EVERY_PROBLEM_WORDS).every((s) => s.length > 20 && s.length < 200 && /\.$/.test(s)), true);

part("The store's numbers read the interval as Stripe bills it");
is("$90 every 3 months is $30 of MRR, never $90", monthly(9000, "month", 3), 3000);
is("$40 every 2 weeks is a month's share of 26 a year", Math.round(monthly(4000, "week", 2)), Math.round((4000 * 52) / 12 / 2));
is("$90 every 6 months is $15", monthly(9000, "month", 6), 1500);

done();
