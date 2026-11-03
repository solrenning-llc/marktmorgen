/**
 * How a recurring series of one call is charged (637 [GL5], unit 5b; added
 * 3 November 2026): the rules, on synthetic dates only.
 */
import { SERIES_CHARGE_HOURS, chargesStopped, refundsOnEnd, seriesBillingProblem, seriesChargeWords, seriesCharges } from "@/lib/call-series-billing";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BOOKED = Date.UTC(2026, 10, 3, 12, 0);
const starts = [BOOKED + 3 * DAY, BOOKED + 10 * DAY, BOOKED + 17 * DAY, BOOKED + 24 * DAY];

part("When each session is charged");
const charges = seriesCharges(starts, 8000, BOOKED);
is("the first when booking, each other one a day before it, each at the length's own price", charges, [{ index: 0, at: BOOKED, cents: 8000 }, { index: 1, at: starts[1] - SERIES_CHARGE_HOURS * HOUR, cents: 8000 }, { index: 2, at: starts[2] - 24 * HOUR, cents: 8000 }, { index: 3, at: starts[3] - 24 * HOUR, cents: 8000 }]);
is("at the creator's cancellation deadline when there is one", seriesCharges(starts, 8000, BOOKED, 48).map((c) => c.at), [BOOKED, starts[1] - 48 * HOUR, starts[2] - 48 * HOUR, starts[3] - 48 * HOUR]);
is("never before the booking itself", seriesCharges([BOOKED + HOUR, BOOKED + 2 * HOUR], 8000, BOOKED, 72).map((c) => c.at), [BOOKED, BOOKED]);

part("Ended early");
const endedAt = starts[1] + HOUR;
is("every charge still to come is never made", chargesStopped(charges, endedAt), [2, 3]);
is("the creator cancelling refunds every session charged and not yet held", refundsOnEnd(charges, starts, starts[2] - 2 * HOUR, "creator", null).map((c) => c.index), [2]);
const withDeadline = seriesCharges(starts, 8000, BOOKED, 48);
is("the buyer cancelling before the deadline was never charged for what is to come", [chargesStopped(withDeadline, starts[2] - 49 * HOUR), refundsOnEnd(withDeadline, starts, starts[2] - 49 * HOUR, "buyer", { hours: 48 })], [[2, 3], []]);
is("past the deadline, what was charged is kept, as for a single booking", refundsOnEnd(withDeadline, starts, starts[2] - 47 * HOUR, "buyer", { hours: 48 }), []);
is("with no deadline promised, nothing is refunded by itself", refundsOnEnd(charges, starts, starts[2] - 2 * HOUR, "buyer", null), []);
is("a session already held is never refunded", refundsOnEnd(charges, starts, starts[1] + HOUR, "creator", null).map((c) => c.index), []);

part("Not with a deposit, a code or a package");
is("refused, each said", [seriesBillingProblem({ deposit: true, code: false, fromPackage: false }), seriesBillingProblem({ deposit: false, code: true, fromPackage: false }), seriesBillingProblem({ deposit: false, code: false, fromPackage: true }), seriesBillingProblem({ deposit: false, code: false, fromPackage: false })], ["deposit", "code", "package", null]);

part("Said before booking");
is("how much and when", seriesChargeWords(4, "$80", "Lena Coaching", 48), "You pay $80 for the first session now, and $80 for each of the other 3 sessions 48 hours before it, Lena Coaching's cancellation deadline. Cancel before a session is charged and you never pay for it.");
is("with no deadline, and one other session", seriesChargeWords(2, "$80", "Lena Coaching"), "You pay $80 for the first session now, and $80 for the other session 24 hours before it. Cancel before a session is charged and you never pay for it.");

done();
