/**
 * How a recurring series of one call is charged (637 [GL5], unit 5b; added
 * 3 November 2026, reworked 4 November 2026): the rules, on synthetic dates
 * and synthetic PaymentIntents only.
 */
import {
  AUTH_WINDOW_HOURS,
  CAPTURE_MARGIN_HOURS,
  HOLD_LEAD_HOURS,
  HOLD_MAX_HOURS,
  SERIES_DEADLINES,
  type ChargeRecord,
  type IntentStatus,
  captureTime,
  chargeAttempt,
  chargeKey,
  failedCharge,
  failedChargeWords,
  paidAfterStop,
  payLink,
  readDeadline,
  refundsOnEnd,
  seriesBillingProblem,
  seriesChargeWords,
  seriesCharges,
  sessionCharge,
  sessionRefunded,
  toStop,
} from "@/lib/call-series-billing";
import { toCancel } from "@/lib/call-series-rules";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BOOKED = Date.UTC(2026, 10, 3, 12, 0);
const LEAST = 50;
const starts = [BOOKED + 3 * DAY, BOOKED + 10 * DAY, BOOKED + 17 * DAY, BOOKED + 24 * DAY];

part("When each session is reserved and charged");
const with48 = seriesCharges(starts, 8000, BOOKED, LEAST, 48)!;
is("each later session: reserved a day before the deadline, charged at the deadline", with48.slice(1).map((c) => [c.way, c.at, c.captureAt, c.refundFee]), starts.slice(1).map((s) => ["hold", s - 72 * HOUR, s - 48 * HOUR, false]));
is("the first: reserved at booking, charged at its deadline when the hold lasts until then", [with48[0].way, with48[0].at, with48[0].captureAt, with48[0].refundFee], ["hold", BOOKED, starts[0] - 48 * HOUR, false]);
const none = seriesCharges(starts, 8000, BOOKED, LEAST)!;
is("no deadline (or zero): reserved a day before the session, charged at its start", [none.slice(1).map((c) => [c.at, c.captureAt]), seriesCharges(starts, 8000, BOOKED, LEAST, 0)], [starts.slice(1).map((s) => [s - 24 * HOUR, s]), none]);
const lateFirst = [BOOKED + 20 * HOUR, BOOKED + 7 * DAY + 20 * HOUR];
is("a first session already inside its deadline at booking: charged at once, never refunded to the buyer, no refund fee", seriesCharges(lateFirst, 8000, BOOKED, LEAST, 48)![0], { index: 0, cents: 8000, at: BOOKED, captureAt: BOOKED, way: "charge", refundFee: false });
const farFirst = [BOOKED + 10 * DAY, BOOKED + 17 * DAY];
is("a first session whose hold would not last until its deadline: charged at once, marked as carrying the refund fee", seriesCharges(farFirst, 8000, BOOKED, LEAST, 48)!.map((c) => [c.way, c.refundFee]), [["charge", true], ["hold", false]]);
is("a moved session: worked out again from its new start", sessionCharge(2, starts[2] + 2 * DAY, BOOKED, 8000, 48), { index: 2, cents: 8000, at: starts[2] + 2 * DAY - 72 * HOUR, captureAt: starts[2] + 2 * DAY - 48 * HOUR, way: "hold", refundFee: false });
is("refused: an amount that is not a whole positive one, below the currency's smallest charge, or a deadline not on the list", [seriesCharges(starts, 0, BOOKED, LEAST), seriesCharges(starts, 80.5, BOOKED, LEAST), seriesCharges(starts, -1, BOOKED, LEAST), seriesCharges(starts, Number.NaN, BOOKED, LEAST), seriesCharges(starts, 40, BOOKED, LEAST), seriesCharges(starts, 8000, BOOKED, LEAST, 0.5), seriesCharges(starts, 8000, BOOKED, LEAST, Number.POSITIVE_INFINITY), seriesCharges(starts, 8000, BOOKED, LEAST, 200)], [null, null, null, null, null, null, null, null]);
is("deadlines read: none or zero is the start, the list as it is, anything else refused", [readDeadline(undefined), readDeadline(null), readDeadline(0), readDeadline(72), readDeadline(36), readDeadline("24")], [0, 0, 0, 72, null, null]);

part("Every capture inside the hold's window, in every case");
is("the longest wait is well inside the shortest window Stripe lists (Visa, merchant-initiated: 4 days 18 hours), with its margin", [AUTH_WINDOW_HOURS, HOLD_MAX_HOURS + CAPTURE_MARGIN_HOURS <= AUTH_WINDOW_HOURS, HOLD_LEAD_HOURS <= HOLD_MAX_HOURS], [114, true, true]);
const broken: string[] = [];
let directCharges = 0;
for (const deadline of [undefined, 0, ...SERIES_DEADLINES]) {
  for (const step of [7, 14]) {
    for (let firstIn = 1; firstIn <= 60 * 24; firstIn += 7) {
      const s = Array.from({ length: 12 }, (_, i) => BOOKED + firstIn * HOUR + i * step * DAY);
      const plan = seriesCharges(s, 8000, BOOKED, LEAST, deadline)!;
      const captures = new Set(plan.map((c) => c.captureAt));
      const say = `${deadline}h, every ${step} days, first in ${firstIn}h`;
      if (captures.size !== plan.length) broken.push(`${say}: two charges at once`);
      for (const c of plan) {
        if (c.at < BOOKED || c.captureAt < BOOKED) broken.push(`${say}: session ${c.index} before booking`);
        if (c.captureAt > s[c.index] || c.at > c.captureAt) broken.push(`${say}: session ${c.index} out of order`);
        if (c.way === "hold" && c.captureAt - c.at > HOLD_MAX_HOURS * HOUR) broken.push(`${say}: session ${c.index} captured after its hold`);
        if (c.way === "charge" && c.index !== 0) broken.push(`${say}: session ${c.index} charged directly`);
        if (c.way === "charge" && c.refundFee) directCharges += 1;
      }
    }
  }
}
is("no two charges together, none before booking, every capture inside its hold, and only a first session ever charged directly", broken, []);
is("and the direct charge with the refund fee happens only for a first session far ahead", directCharges > 0, true);
const held = with48[2];
is("when Stripe says a hold expires sooner, it is captured before that and carries the refund fee", [captureTime(held, null), captureTime(held, held.captureAt + 10 * HOUR), captureTime(held, held.captureAt - 2 * HOUR)], [{ at: held.captureAt, refundFee: false }, { at: held.captureAt, refundFee: false }, { at: held.captureAt - (2 + CAPTURE_MARGIN_HOURS) * HOUR, refundFee: true }]);

part("A hold that fails");
const with72 = seriesCharges(starts, 8000, BOOKED, LEAST, 72)!;
is("72-hour deadline: reserved 96 hours before; the link is valid until the deadline; at the deadline, canceled unpaid", [with72[2].at, failedCharge(starts[2], with72[2].at, 72), failedCharge(starts[2], starts[2] - 72 * HOUR - 1, 72), failedCharge(starts[2], starts[2] - 72 * HOUR, 72)], [starts[2] - 96 * HOUR, "pay_by_link", "pay_by_link", "cancel"]);
is("never a free late cancellation: an unpaid session never stays booked past the creator's deadline", SERIES_DEADLINES.every((d) => failedCharge(starts[2], starts[2] - d * HOUR, d) === "cancel"), true);
is("no deadline: the link is valid until the session starts", [failedCharge(starts[2], starts[2] - 1, 0), failedCharge(starts[2], starts[2], 0)], ["pay_by_link", "cancel"]);
is("the buyer is told the link and the deadline", failedChargeWords({ to: "buyer", what: "pay_by_link", date: "Friday, November 20 at 9:00 AM EST", payBy: "Tuesday, November 17 at 9:00 AM EST", deadlineHours: 72 }), "Your card could not be reserved for your session on Friday, November 20 at 9:00 AM EST. Pay with the link below by Tuesday, November 17 at 9:00 AM EST. If it is not paid by then, the session is canceled and you are not charged.");
is("the creator is told the same, without the buyer's name", failedChargeWords({ to: "creator", what: "pay_by_link", date: "Friday, November 20 at 9:00 AM EST", payBy: "Tuesday, November 17 at 9:00 AM EST", deadlineHours: 72 }), "The buyer's card could not be reserved for the session on Friday, November 20 at 9:00 AM EST. We emailed them a link to pay by Tuesday, November 17 at 9:00 AM EST. If it is not paid by then, the session is canceled and its time opens again.");
is("canceled at the deadline: both told exactly that", [failedChargeWords({ to: "buyer", what: "cancel", date: "Friday, November 20", payBy: "", deadlineHours: 72 }), failedChargeWords({ to: "creator", what: "cancel", date: "Friday, November 20", payBy: "", deadlineHours: 72 }), failedChargeWords({ to: "buyer", what: "cancel", date: "Friday, November 20", payBy: "", deadlineHours: 0 })], ["Your session on Friday, November 20 was canceled at the cancellation deadline, because it was not paid. You were not charged for it.", "The session on Friday, November 20 was canceled at the cancellation deadline, because it was not paid. Nothing was charged, and its time is open again.", "Your session on Friday, November 20 was canceled before it started, because it was not paid. You were not charged for it."]);

part("Stopping sessions closes their PaymentIntents");
const rec = (index: number, status: IntentStatus | null, extra: Partial<ChargeRecord> = {}): ChargeRecord => ({ index, cents: 8000, attempt: status === null ? 0 : 1, intent: status === null ? null : { id: `pi_${index}`, status }, refunded: false, ...extra });
const ended = starts[1] + HOUR;
const canceled = toCancel(starts, ended);
const stop = toStop(canceled, [rec(0, "succeeded"), rec(1, "succeeded"), rec(2, "requires_payment_method"), rec(3, "requires_capture")]);
is("ended early: the failed charge's PaymentIntent and the hold are canceled, so no pay link can charge them", stop, { never: [2, 3], cancel: ["pi_2", "pi_3"], lookUp: [] });
is("an attempt with no id stored is looked up first; one never started needs nothing; a canceled one stays canceled; one captured is left to the refund rule", toStop([0, 1, 2, 3], [rec(0, null, { attempt: 1 }), rec(1, null), rec(2, "canceled"), rec(3, "succeeded")]), { never: [0, 1, 2], cancel: [], lookUp: [0] });
is("every open state is canceled, and a processing one too (refunded in full if it still succeeds)", (["requires_payment_method", "requires_confirmation", "requires_action", "processing"] as IntentStatus[]).map((s) => toStop([2], [rec(2, s)]).cancel), [["pi_2"], ["pi_2"], ["pi_2"], ["pi_2"]]);

part("The pay link re-checks the session");
const link = { stopped: false, status: "requires_payment_method" as IntentStatus, now: starts[2] - 80 * HOUR, start: starts[2], deadlineHours: 72 };
is("open while the session stands and the deadline has not come", payLink(link), "pay");
is("refused once the session is stopped, even inside the deadline", payLink({ ...link, stopped: true }), "stopped");
is("refused at the deadline", payLink({ ...link, now: starts[2] - 72 * HOUR }), "late");
is("nothing to pay once reserved or paid", [payLink({ ...link, status: "requires_capture" }), payLink({ ...link, status: "succeeded" })], ["done", "done"]);
is("a payment that succeeds after its session was stopped is refunded in full by itself; a hold is released", [paidAfterStop("succeeded"), paidAfterStop("requires_capture"), paidAfterStop("requires_action"), paidAfterStop("canceled")], ["refund_in_full", "release", "cancel", "none"]);

part("A retry days later never creates a second PaymentIntent");
const meta = (session: number, series = "s1") => ({ series, session: String(session) });
is("the key carries the attempt", [chargeKey("s1", 3, 1), chargeKey("s1", 3, 2)], ["series:s1:3:1", "series:s1:3:2"]);
// The attempt was written, the PaymentIntent created, and the id never stored: 70 hours later the key may be gone, but the list still shows it.
is("an attempt with no id stored: the one found on the account is reused, whatever the key's age", chargeAttempt("s1", rec(2, null, { attempt: 1 }), [{ id: "pi_x", status: "requires_payment_method", metadata: meta(2) }]), { do: "reuse", id: "pi_x", extra: [] });
is("a stored one is reused", chargeAttempt("s1", rec(2, "requires_action"), []), { do: "reuse", id: "pi_2", extra: [] });
is("only PaymentIntents of this series and this session count", chargeAttempt("s1", rec(2, null), [{ id: "pi_a", status: "succeeded", metadata: meta(3) }, { id: "pi_b", status: "succeeded", metadata: meta(2, "s2") }]), { do: "create", attempt: 1, key: "series:s1:2:1" });
is("only canceled ones: a new one, under the next attempt's key", chargeAttempt("s1", rec(2, "canceled"), [{ id: "pi_2", status: "canceled", metadata: meta(2) }]), { do: "create", attempt: 2, key: "series:s1:2:2" });
is("two found: the one furthest along is kept and the other closed (refunded if paid)", chargeAttempt("s1", rec(2, "requires_payment_method"), [{ id: "pi_new", status: "succeeded", metadata: meta(2) }, { id: "pi_old", status: "succeeded", metadata: meta(2) }]), { do: "reuse", id: "pi_new", extra: [{ id: "pi_old", action: "refund_in_full" }, { id: "pi_2", action: "cancel" }] });

part("Refunds when a series ends");
const paid = [rec(0, "succeeded"), rec(1, "succeeded"), rec(2, "succeeded")];
is("the creator ending it refunds every session captured and not yet held", refundsOnEnd(paid, starts, starts[1] + HOUR, "creator", 48).map((c) => c.index), [2]);
is("a session already held is never refunded", refundsOnEnd(paid, starts, starts[2] + HOUR, "creator", 48).map((c) => c.index), []);
is("the buyer ending it at least the deadline before a session captured gets it back, the instant itself included; later, not", [refundsOnEnd(paid, starts, starts[2] - 48 * HOUR - 1, "buyer", 48).map((c) => c.index), refundsOnEnd(paid, starts, starts[2] - 48 * HOUR, "buyer", 48).map((c) => c.index), refundsOnEnd(paid, starts, starts[2] - 47 * HOUR, "buyer", 48).map((c) => c.index)], [[2], [2], []]);
is("a charge already refunded is never refunded again", refundsOnEnd([rec(2, "succeeded", { refunded: true }), rec(3, "succeeded")], starts, starts[1], "creator", 48).map((c) => c.index), [3]);
is("only what was captured: a hold is released by toStop, never refunded", refundsOnEnd([rec(2, "requires_capture"), rec(3, "processing")], starts, starts[1], "creator", 48), []);
is("a first session already inside the deadline when booked is never refunded by the buyer ending it, even at once", refundsOnEnd([rec(0, "succeeded")], lateFirst, BOOKED, "buyer", 48), []);
is("no deadline: a buyer canceling before the start is refunded what was captured", refundsOnEnd([rec(0, "succeeded")], farFirst, BOOKED + HOUR, "buyer", 0).map((c) => c.index), [0]);

part("One session canceled on its own");
is("the buyer canceling one captured session at least the deadline before it is refunded; later, not; the creator canceling it, always before it starts", [sessionRefunded(rec(2, "succeeded"), starts[2], starts[2] - 48 * HOUR, "buyer", 48), sessionRefunded(rec(2, "succeeded"), starts[2], starts[2] - 47 * HOUR, "buyer", 48), sessionRefunded(rec(2, "succeeded"), starts[2], starts[2] - HOUR, "creator", 48), sessionRefunded(rec(2, "succeeded"), starts[2], starts[2] + HOUR, "creator", 48)], [true, false, true, false]);

part("Not with a deposit, a code or a package");
is("refused, each said", [seriesBillingProblem({ deposit: true, code: false, fromPackage: false }), seriesBillingProblem({ deposit: false, code: true, fromPackage: false }), seriesBillingProblem({ deposit: false, code: false, fromPackage: true }), seriesBillingProblem({ deposit: false, code: false, fromPackage: false })], ["deposit", "code", "package", null]);

part("What the buyer agrees to before booking");
const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const dates = ["Friday, November 6 at 9:00 AM EST", "Friday, November 13 at 9:00 AM EST", "Friday, November 20 at 9:00 AM EST", "Friday, November 27 at 9:00 AM EST"];
const said = seriesChargeWords({ charges: with48, starts, dates, money, store: "Lena Coaching", bookedAt: BOOKED, deadlineHours: 48 });
is("the count and total from the charges, the dates, the saved card, when each is reserved and charged, a failed card, canceling, the creator canceling", said, "You book 4 sessions for $320 in all. The dates: Friday, November 6 at 9:00 AM EST; Friday, November 13 at 9:00 AM EST; Friday, November 20 at 9:00 AM EST; Friday, November 27 at 9:00 AM EST. Your card is saved with Lena Coaching's payment account and used without you there, as described here. For each session, $80 is reserved on your card a day before the cancellation deadline. It is charged at the deadline, 48 hours before the session starts. For the first session, it is reserved now. If your card cannot be reserved, we email you a link to pay. Pay by the cancellation deadline, or that session is canceled and you are not charged. Cancel a session at least 48 hours before it starts and you pay nothing for it. The reservation is released, and anything already charged is refunded. If you cancel later or miss it, it is not refunded. If Lena Coaching cancels, you get back what was charged for every session that does not take place. This does not affect your rights under the law.");
const lateSaid = seriesChargeWords({ charges: seriesCharges(lateFirst, 8000, BOOKED, LEAST, 48)!, starts: lateFirst, dates: ["a", "b"], money, store: "Lena Coaching", bookedAt: BOOKED, deadlineHours: 48 });
is("a first session already inside the deadline: charged now and not refunded, said", lateSaid.includes("The first session starts in less than 48 hours, so it is charged now and not refunded."), true);
is("a first session charged directly: said", seriesChargeWords({ charges: seriesCharges(farFirst, 8000, BOOKED, LEAST, 48)!, starts: farFirst, dates: ["a", "b"], money, store: "Lena Coaching", bookedAt: BOOKED, deadlineHours: 48 }).includes("The first session is charged now."), true);
const noneSaid = seriesChargeWords({ charges: none, starts, dates, money, store: "Lena Coaching", bookedAt: BOOKED });
is("no deadline: reserved a day before, charged at the start, cancel any time before it", [noneSaid.includes("$80 is reserved on your card a day before it starts. It is charged when the session starts."), noneSaid.includes("Cancel a session any time before it starts and you pay nothing for it."), noneSaid.includes("Pay before the session starts, or it is canceled and you are not charged.")], [true, true, true]);
const words = (text: string) => text.split(/(?<=\.)\s+(?=[A-Z])/).filter((s) => !s.startsWith("The dates:"));
const long = [said, lateSaid, noneSaid].flatMap(words).filter((s) => s.split(/\s+/).length >= 21);
is("every sentence under 21 words (the list of dates aside)", long, []);
const refused = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
is("refused, never said wrong: dates or starts that do not match the charges, charges at different prices, or none", [refused(() => seriesChargeWords({ charges: with48, starts, dates: dates.slice(0, 3), money, store: "x", bookedAt: BOOKED, deadlineHours: 48 })), refused(() => seriesChargeWords({ charges: with48, starts: starts.slice(0, 3), dates, money, store: "x", bookedAt: BOOKED, deadlineHours: 48 })), refused(() => seriesChargeWords({ charges: [with48[0], { ...with48[1], cents: 9000 }], starts: starts.slice(0, 2), dates: ["a", "b"], money, store: "x", bookedAt: BOOKED, deadlineHours: 48 })), refused(() => seriesChargeWords({ charges: [], starts: [], dates: [], money, store: "x", bookedAt: BOOKED }))], [true, true, true, true]);
is("refused: a charge whose time is not the one announced, or charges planned for another deadline", [refused(() => seriesChargeWords({ charges: [with48[0], { ...with48[1], captureAt: with48[1].captureAt + HOUR }, ...with48.slice(2)], starts, dates, money, store: "x", bookedAt: BOOKED, deadlineHours: 48 })), refused(() => seriesChargeWords({ charges: with72, starts, dates, money, store: "x", bookedAt: BOOKED, deadlineHours: 48 })), refused(() => seriesChargeWords({ charges: none, starts, dates, money, store: "x", bookedAt: BOOKED, deadlineHours: 48 }))], [true, true, true]);
is("refused: a deadline not on the list is never said as no deadline", [refused(() => seriesChargeWords({ charges: none, starts, dates, money, store: "x", bookedAt: BOOKED, deadlineHours: 36 })), refused(() => seriesChargeWords({ charges: none, starts, dates, money, store: "x", bookedAt: BOOKED, deadlineHours: Number.NaN }))], [true, true]);

done();
