/**
 * How a recurring series of one call is charged (637 [GL5], unit 5b; added
 * 3 November 2026): the rules, on synthetic dates only.
 */
import { PAY_BY_HOURS, SERIES_CHARGE_HOURS, failedCharge, refundsOnEnd, seriesBillingProblem, seriesChargeWords, seriesCharges, toStop } from "@/lib/call-series-billing";
import { toCancel } from "@/lib/call-series-rules";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BOOKED = Date.UTC(2026, 10, 3, 12, 0);
const LEAST = 50;
const starts = [BOOKED + 3 * DAY, BOOKED + 10 * DAY, BOOKED + 17 * DAY, BOOKED + 24 * DAY];

part("When each session is due");
const plain = seriesCharges(starts, 8000, BOOKED, LEAST)!;
is("the first when booking, each other one a day before it, each at the length's own price", plain, [{ index: 0, at: BOOKED, cents: 8000 }, { index: 1, at: starts[1] - SERIES_CHARGE_HOURS * HOUR, cents: 8000 }, { index: 2, at: starts[2] - 24 * HOUR, cents: 8000 }, { index: 3, at: starts[3] - 24 * HOUR, cents: 8000 }]);
const deadline = seriesCharges(starts, 8000, BOOKED, LEAST, 48)!;
is("at the deadline promised when there is one", deadline.map((c) => c.at), [BOOKED, starts[1] - 48 * HOUR, starts[2] - 48 * HOUR, starts[3] - 48 * HOUR]);
is("never before the booking itself", seriesCharges([BOOKED + HOUR, BOOKED + 8 * DAY], 8000, BOOKED, LEAST, 72)!.map((c) => c.at), [BOOKED, BOOKED + 5 * DAY]);
is("refused: an amount that is not a whole positive one, below the currency's smallest charge, or a deadline not on the list", [seriesCharges(starts, 0, BOOKED, LEAST), seriesCharges(starts, 80.5, BOOKED, LEAST), seriesCharges(starts, -1, BOOKED, LEAST), seriesCharges(starts, Number.NaN, BOOKED, LEAST), seriesCharges(starts, 40, BOOKED, LEAST), seriesCharges(starts, 8000, BOOKED, LEAST, 0.5), seriesCharges(starts, 8000, BOOKED, LEAST, Number.POSITIVE_INFINITY), seriesCharges(starts, 8000, BOOKED, LEAST, 200)], [null, null, null, null, null, null, null, null]);

part("Charged by its record, never by the time it was due");
const ended = starts[1] + HOUR;
const canceled = toCancel(starts, ended);
is("ended early: every session canceled and not yet charged is never charged, even one past its due time", toStop(canceled, new Set([0, 1])), [2, 3]);
is("a session due a minute ago and not yet charged is stopped too", toStop([2, 3], new Set([0, 1])), [2, 3]);

part("A charge that fails");
is("paid with the card in hand until two hours before the session; then canceled, its time freed, nothing charged", [failedCharge(starts[2], starts[2] - (PAY_BY_HOURS + 1) * HOUR), failedCharge(starts[2], starts[2] - PAY_BY_HOURS * HOUR), failedCharge(starts[2], starts[2] - HOUR)], ["pay_by_link", "cancel", "cancel"]);

part("Refunds when a series ends");
const charged = deadline.slice(0, 3);
is("the creator ending it refunds every session charged and not yet held", refundsOnEnd(charged, starts, starts[1] + HOUR, "creator", 48).map((c) => c.index), [2]);
is("a session already held is never refunded", refundsOnEnd(charged, starts, starts[2] + HOUR, "creator", 48).map((c) => c.index), []);
is("the buyer ending it before the deadline of a session already charged gets it back; at the deadline or after, not", [refundsOnEnd(charged, starts, starts[2] - 48 * HOUR - 1, "buyer", 48).map((c) => c.index), refundsOnEnd(charged, starts, starts[2] - 48 * HOUR, "buyer", 48).map((c) => c.index), refundsOnEnd(charged, starts, starts[2] - 47 * HOUR, "buyer", 48).map((c) => c.index)], [[2], [], []]);
is("with no deadline promised, nothing is refunded by itself", refundsOnEnd(plain.slice(0, 3), starts, starts[2] - 2 * HOUR, "buyer"), []);

part("Not with a deposit, a code or a package");
is("refused, each said", [seriesBillingProblem({ deposit: true, code: false, fromPackage: false }), seriesBillingProblem({ deposit: false, code: true, fromPackage: false }), seriesBillingProblem({ deposit: false, code: false, fromPackage: true }), seriesBillingProblem({ deposit: false, code: false, fromPackage: false })], ["deposit", "code", "package", null]);

part("What the buyer agrees to before booking");
const said = seriesChargeWords({ count: 4, price: "$80", total: "$320", dates: ["Friday, November 6 at 9:00 AM EST", "Friday, November 13 at 9:00 AM EST", "Friday, November 20 at 9:00 AM EST", "Friday, November 27 at 9:00 AM EST"], store: "Lena Coaching", deadlineHours: 48 });
is("the total and each date, that the card is saved and charged without them, each amount and when, a failed charge, and canceling", [said.startsWith("You book 4 sessions for $320 in all: Friday, November 6"), said.includes("Your card is saved with Lena Coaching's payment account and charged $80 for each session, without you there: the first now, and each other one 48 hours before it starts."), said.includes("If a charge does not go through, we email you a link to pay it yourself until 2 hours before that session."), said.includes("The first session is charged now and is not refunded.")], [true, true, true, true]);
is("with no deadline, a session charged is the creator's to refund", seriesChargeWords({ count: 2, price: "$80", total: "$160", dates: ["a", "b"], store: "Lena Coaching" }).endsWith("Once charged, a session is not refunded by itself; ask Lena Coaching."), true);

done();
