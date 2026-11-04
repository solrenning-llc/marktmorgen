/**
 * How a recurring series of one call is charged (637 [GL5], unit 5b; added
 * 3 November 2026): the rules, on synthetic dates only.
 */
import { PAY_BY_HOURS, PAY_WINDOW_HOURS, SERIES_CHARGE_HOURS, chargeDueAt, chargeKey, chargeLeadHours, failedCharge, refundsOnEnd, seriesBillingProblem, seriesChargeWords, seriesCharges, sessionRefunded, toStop } from "@/lib/call-series-billing";
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

part("Due times");
is("a deadline shorter than the time to pay a failed charge is charged early enough to pay it by the link", [chargeLeadHours(2), chargeLeadHours(12), chargeLeadHours(24), chargeLeadHours(), PAY_BY_HOURS + PAY_WINDOW_HOURS], [12, 12, 24, SERIES_CHARGE_HOURS, 12]);
const twoHour = seriesCharges(starts, 8000, BOOKED, LEAST, 2)!;
is("with a 2-hour deadline, each session is charged 12 hours before it, and a charge failing then can still be paid by the link", [twoHour[1].at, failedCharge(starts[1], twoHour[1].at)], [starts[1] - 12 * HOUR, "pay_by_link"]);
is("a session moved within the rules is charged at its new start's due time", chargeDueAt(2, starts[2] + 2 * DAY, BOOKED, 48), starts[2] + 2 * DAY - 48 * HOUR);
is("each session's charge has its own key, the same for a retry and the link to pay it", [chargeKey("s1", 0), chargeKey("s1", 3), chargeKey("s1", 3) === chargeKey("s1", 3)], ["series:s1:0", "series:s1:3", true]);

part("A charge that fails");
is("paid with the card in hand until two hours before the session; then canceled, its time freed, nothing charged", [failedCharge(starts[2], starts[2] - (PAY_BY_HOURS + 1) * HOUR), failedCharge(starts[2], starts[2] - PAY_BY_HOURS * HOUR), failedCharge(starts[2], starts[2] - HOUR)], ["pay_by_link", "cancel", "cancel"]);

part("Refunds when a series ends");
const charged = deadline.slice(0, 3);
is("the creator ending it refunds every session charged and not yet held", refundsOnEnd(charged, starts, starts[1] + HOUR, "creator", 48).map((c) => c.index), [2]);
is("a session already held is never refunded", refundsOnEnd(charged, starts, starts[2] + HOUR, "creator", 48).map((c) => c.index), []);
is("the buyer ending it at least the deadline before a session already charged gets it back, the instant itself included (as 520 [LB1] says at least); later, not", [refundsOnEnd(charged, starts, starts[2] - 48 * HOUR - 1, "buyer", 48).map((c) => c.index), refundsOnEnd(charged, starts, starts[2] - 48 * HOUR, "buyer", 48).map((c) => c.index), refundsOnEnd(charged, starts, starts[2] - 47 * HOUR, "buyer", 48).map((c) => c.index)], [[2], [2], []]);
is("the first session follows the same rule: ended at least the deadline before it, it is refunded", refundsOnEnd(charged, starts, BOOKED + HOUR, "buyer", 48).map((c) => c.index), [0, 1, 2]);
const lateFirst = [BOOKED + 20 * HOUR, BOOKED + 7 * DAY + 20 * HOUR];
const lateCharges = seriesCharges(lateFirst, 8000, BOOKED, LEAST, 48)!;
is("a first session already inside the deadline when booked is never refunded by the buyer ending it, even at once", refundsOnEnd(lateCharges.slice(0, 1), lateFirst, BOOKED, "buyer", 48), []);
is("with no deadline promised, nothing is refunded by itself", refundsOnEnd(plain.slice(0, 3), starts, starts[2] - 2 * HOUR, "buyer"), []);

part("One session canceled on its own");
is("the buyer canceling one charged session at least the deadline before it is refunded; later, not; the creator canceling it, always before it starts", [sessionRefunded(charged[2], starts[2], starts[2] - 48 * HOUR, "buyer", 48), sessionRefunded(charged[2], starts[2], starts[2] - 47 * HOUR, "buyer", 48), sessionRefunded(charged[2], starts[2], starts[2] - HOUR, "creator", 48), sessionRefunded(charged[2], starts[2], starts[2] + HOUR, "creator", 48)], [true, false, true, false]);

part("Not with a deposit, a code or a package");
is("refused, each said", [seriesBillingProblem({ deposit: true, code: false, fromPackage: false }), seriesBillingProblem({ deposit: false, code: true, fromPackage: false }), seriesBillingProblem({ deposit: false, code: false, fromPackage: true }), seriesBillingProblem({ deposit: false, code: false, fromPackage: false })], ["deposit", "code", "package", null]);

part("What the buyer agrees to before booking");
const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const dates = ["Friday, November 6 at 9:00 AM EST", "Friday, November 13 at 9:00 AM EST", "Friday, November 20 at 9:00 AM EST", "Friday, November 27 at 9:00 AM EST"];
const said = seriesChargeWords({ charges: deadline, starts, dates, money, store: "Lena Coaching", bookedAt: BOOKED, deadlineHours: 48 });
is("the count and the total worked out from the charges, each date, that the card is saved and charged without them, each amount and when, a failed charge, canceling and the creator canceling", [said.startsWith("You book 4 sessions for $320 in all: Friday, November 6"), said.includes("Your card is saved with Lena Coaching's payment account and charged $80 for each session, without you there: the first now, and each other one 48 hours before it starts."), said.includes("If a charge does not go through, we email you a link to pay it yourself until 2 hours before that session."), said.includes("Cancel a session at least 48 hours before it starts and you pay nothing for it: one already charged, the first included, is refunded. If you cancel later or miss it, it is not refunded."), said.includes("If Lena Coaching cancels, you get back what was charged for every session not held. This does not affect your rights under the law.")], [true, true, true, true, true]);
is("the words never say the first session is not refunded when it can be", said.includes("The first session starts in less than"), false);
const lateSaid = seriesChargeWords({ charges: lateCharges, starts: lateFirst, dates: ["a", "b"], money, store: "Lena Coaching", bookedAt: BOOKED, deadlineHours: 48 });
is("a first session already inside the deadline: said, as one booking's cancelTooLate says it", [lateSaid.includes("one already charged is refunded."), lateSaid.includes("The first session starts in less than 48 hours, so it is not refunded.")], [true, true]);
is("a 2-hour deadline says when the charge really comes", seriesChargeWords({ charges: twoHour, starts, dates, money, store: "Lena Coaching", bookedAt: BOOKED, deadlineHours: 2 }).includes("each other one 12 hours before it starts"), true);
is("with no deadline, a session charged is the creator's to refund", seriesChargeWords({ charges: plain.slice(0, 2), starts: starts.slice(0, 2), dates: ["a", "b"], money, store: "Lena Coaching", bookedAt: BOOKED }).includes("Once charged, a session is not refunded by itself; ask Lena Coaching."), true);
const refused = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
is("refused, never said wrong: dates or starts that do not match the charges, or charges at different prices", [refused(() => seriesChargeWords({ charges: deadline, starts, dates: dates.slice(0, 3), money, store: "x", bookedAt: BOOKED })), refused(() => seriesChargeWords({ charges: deadline, starts: starts.slice(0, 3), dates, money, store: "x", bookedAt: BOOKED })), refused(() => seriesChargeWords({ charges: [deadline[0], { ...deadline[1], cents: 9000 }], starts: starts.slice(0, 2), dates: ["a", "b"], money, store: "x", bookedAt: BOOKED })), refused(() => seriesChargeWords({ charges: [], starts: [], dates: [], money, store: "x", bookedAt: BOOKED }))], [true, true, true, true]);

done();
