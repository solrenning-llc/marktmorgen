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
  type SeriesCharge,
  type FoundIntent,
  type IntentStatus,
  CAPTURE_DELAY_MS,
  captureTime,
  chargeAttempt,
  holdGoodUntil,
  keptOnCharge,
  keptOnMove,
  startAttempt,
  createErrorStep,
  refundOutcome,
  moveCase,
  keptWhen,
  unpaidCancel,
  payBy,
  chargeKey,
  failedCharge,
  failedChargeWords,
  paidAfterStop,
  payLink,
  readDeadline,
  seriesBillingProblem,
  seriesChargeWords,
  seriesCharges,
  sessionCharge,
  sessionRefunded,
  seriesMetadata,
  stepKey,
  toStop,
} from "@/lib/call-series-billing";
import { toCancel } from "@/lib/call-series-rules";
import { SERIES_MOVE_WORDS, seriesMoveMessage } from "@/lib/buyer-words/series-move";
import { LANGUAGE_CODES } from "@/lib/store-language";
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
is("a first session already inside its deadline at booking: charged at once, never refunded to the buyer, no refund fee", seriesCharges(lateFirst, 8000, BOOKED, LEAST, 48)![0], { index: 0, cents: 8000, at: BOOKED, captureAt: BOOKED, way: "charge", refundFee: false, movedBy: null, cancelBy: lateFirst[0] - 48 * HOUR });
const farFirst = [BOOKED + 10 * DAY, BOOKED + 17 * DAY];
is("a first session whose hold would not last until its deadline: charged at once, marked as carrying the refund fee", seriesCharges(farFirst, 8000, BOOKED, LEAST, 48)!.map((c) => [c.way, c.refundFee]), [["charge", true], ["hold", false]]);
is("a moved session: worked out again from its new start", sessionCharge(2, starts[2] + 2 * DAY, BOOKED, 8000, 48), { index: 2, cents: 8000, at: starts[2] + 2 * DAY - 72 * HOUR, captureAt: starts[2] + 2 * DAY - 48 * HOUR, way: "hold", refundFee: false, movedBy: null, cancelBy: starts[2] + 2 * DAY - 48 * HOUR });
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
type Hold = { heldAt: number | null; captureBefore?: number | null; created?: number; capture?: "manual" | "automatic"; attempt?: number | null };
const intent = (id: string, status: IntentStatus, h: Hold = { heldAt: null }) => ({ id, status, capture: h.capture ?? ("manual" as const), created: h.created ?? BOOKED, heldAt: h.heldAt, captureBefore: h.captureBefore ?? null, attempt: h.attempt ?? null });
const GOOD = (AUTH_WINDOW_HOURS - CAPTURE_MARGIN_HOURS) * HOUR;
const at = (heldAt: number, captureBefore: number | null = null) => intent("pi_h", "requires_capture", { heldAt, captureBefore });
is("a hold is captured a minute after the deadline while it is good: Stripe's capture_before, or the shortest window from the hold when unsaid", [captureTime(held, at(held.at), held.at), captureTime(held, at(held.at, held.captureAt + 10 * HOUR), held.at), holdGoodUntil(held.at, null)], [{ do: "capture", at: held.captureAt + CAPTURE_DELAY_MS }, { do: "capture", at: held.captureAt + CAPTURE_DELAY_MS }, held.at + GOOD]);
is("a capture job running late captures at once, while the hold is good", captureTime(held, at(held.at), held.captureAt + HOUR), { do: "capture", at: held.captureAt + HOUR });
is("a hold that expires sooner is released and placed again before the deadline, never captured before it", captureTime(held, at(held.at, held.captureAt - 2 * HOUR), held.at + HOUR), { do: "rehold", at: held.at + HOUR });
is("from the deadline on, a hold that would not last is charged at once, never placed again", [captureTime(held, at(held.at, held.captureAt - 2 * HOUR), held.captureAt), captureTime(held, at(held.at - 5 * DAY), held.captureAt + HOUR)], [{ do: "charge_now", at: held.captureAt }, { do: "charge_now", at: held.captureAt + HOUR }]);
// A session moved a week later on a hold placed at its old time.
const moved = sessionCharge(2, starts[2] + 7 * DAY, BOOKED, 8000, 48);
const oldBefore = held.at + AUTH_WINDOW_HOURS * HOUR;
const afterMove = captureTime(moved, at(held.at, oldBefore), held.at + HOUR);
is("captureTime never returns a capture at or after capture_before: an old hold for a moved session is placed again at its new time", [afterMove, afterMove.do !== "capture" || afterMove.at < oldBefore], [{ do: "rehold", at: moved.at }, true]);
const capturesInWindow: string[] = [];
for (const now of [held.at, held.captureAt - HOUR, held.captureAt, held.captureAt + 5 * HOUR, held.captureAt + 3 * DAY, held.captureAt + 6 * DAY]) {
  for (const before of [null, held.at + HOUR, held.captureAt, held.captureAt + 6 * HOUR, held.at + 7 * DAY]) {
    const r = captureTime(held, at(held.at, before), now);
    if (r.do === "capture" && (r.at >= (before ?? held.at + AUTH_WINDOW_HOURS * HOUR) || r.at <= held.captureAt || r.at < now)) capturesInWindow.push(`capture ${now} ${before}`);
    if (r.do === "rehold" && now >= held.captureAt) capturesInWindow.push(`hold after the deadline ${now} ${before}`);
  }
}
is("whatever the hold's expiry and the time the job runs: every capture before the expiry, after the deadline, never in the past, and no hold placed after the deadline", capturesInWindow, []);
is("the capture a minute after the deadline stays inside the window for the longest planned wait", HOLD_MAX_HOURS * HOUR + CAPTURE_DELAY_MS <= GOOD, true);
is("a hold with no time stored or listed counts from its PaymentIntent's creation, never as fine", captureTime(held, intent("pi_h", "requires_capture", { heldAt: null, created: held.at - 5 * DAY }), held.at).do, "rehold");

part("A session moved");
const NOW = BOOKED + 10 * DAY;
const inside = sessionCharge(2, NOW + 10 * HOUR, BOOKED, 8000, 48, NOW);
is("moved inside its deadline: never planned in the past, charged at once and not refunded to a buyer canceling", [inside.at >= NOW && inside.captureAt >= NOW, inside], [true, { index: 2, cents: 8000, at: NOW, captureAt: NOW, way: "charge", refundFee: false, movedBy: null, cancelBy: NOW + 10 * HOUR - 48 * HOUR }]);
is("moved inside its deadline with a hold still good: that hold is captured at once, not left uncaptured", captureTime(inside, at(NOW - 2 * HOUR), NOW), { do: "capture", at: NOW });
is("moved to a day after its deadline would come: held now, captured at the deadline", sessionCharge(2, NOW + 60 * HOUR, BOOKED, 8000, 48, NOW), { index: 2, cents: 8000, at: NOW, captureAt: NOW + 12 * HOUR, way: "hold", refundFee: false, movedBy: null, cancelBy: NOW + 12 * HOUR });
is("a first session moved later is held a day before its deadline like the others, never charged early", sessionCharge(0, NOW + 20 * DAY, BOOKED, 8000, 48, NOW), { index: 0, cents: 8000, at: NOW + 20 * DAY - 72 * HOUR, captureAt: NOW + 20 * DAY - 48 * HOUR, way: "hold", refundFee: false, movedBy: null, cancelBy: NOW + 20 * DAY - 48 * HOUR });
is("a charge made at or after the deadline is kept; one made before it is not", [keptWhen(NOW, NOW + 10 * HOUR, 48), keptWhen(held.captureAt + CAPTURE_DELAY_MS, starts[2], 48), keptWhen(BOOKED, farFirst[0], 48)], [true, true, false]);

part("A payment that fails");
const with72 = seriesCharges(starts, 8000, BOOKED, LEAST, 72)!;
is("a failed hold, 72-hour deadline: reserved 96 hours before; the link is valid until the deadline; at the deadline, canceled unpaid", [with72[2].at, failedCharge(starts[2], with72[2].at, 72, "hold"), failedCharge(starts[2], starts[2] - 72 * HOUR - 1, 72, "hold"), failedCharge(starts[2], starts[2] - 72 * HOUR, 72, "hold"), payBy(starts[2], 72, "hold")], [starts[2] - 96 * HOUR, "pay_by_link", "pay_by_link", "cancel", starts[2] - 72 * HOUR]);
is("never a free late cancellation: an unpaid hold never stays booked past the creator's deadline", SERIES_DEADLINES.every((d) => failedCharge(starts[2], starts[2] - d * HOUR, d, "hold") === "cancel"), true);
is("a capture that fails at the deadline is no fault of the buyer: charged at once; if that fails, the link works until the start", [failedCharge(starts[2], starts[2] - 72 * HOUR, 72, "capture"), failedCharge(starts[2], starts[2] - HOUR, 72, "charge"), payBy(starts[2], 72, "charge")], ["charge_now", "pay_by_link", starts[2]]);
is("a charge failing once the session has started never cancels a session that took place: it stays owed", [failedCharge(starts[2], starts[2], 72, "charge"), failedCharge(starts[2], starts[2] + HOUR, 0, "charge"), failedCharge(starts[2], starts[2] + HOUR, 72, "capture")], ["owed", "owed", "charge_now"]);
is("no deadline: the link after a failed hold is valid until the session starts", [failedCharge(starts[2], starts[2] - 1, 0, "hold"), failedCharge(starts[2], starts[2], 0, "hold")], ["pay_by_link", "cancel"]);
const fw = (to: "buyer" | "creator", what: "pay_by_link" | "cancel" | "owed", step: "hold" | "charge", deadlineHours: number) => failedChargeWords({ to, what, step, date: "Friday, November 20 at 9:00 AM EST", payBy: "Tuesday, November 17 at 9:00 AM EST", deadlineHours });
is("the buyer is told the link and until when, as reserved or charged by the step", [fw("buyer", "pay_by_link", "hold", 72), fw("buyer", "pay_by_link", "charge", 72)], ["Your card could not be reserved for your session on Friday, November 20 at 9:00 AM EST. Pay with the link below by Tuesday, November 17 at 9:00 AM EST. If it is not paid by then, the session is canceled and you are not charged.", "Your card could not be charged for your session on Friday, November 20 at 9:00 AM EST. Pay with the link below by Tuesday, November 17 at 9:00 AM EST. If it is not paid by then, the session is canceled and you are not charged."]);
is("the creator is told the same, without the buyer's name", fw("creator", "pay_by_link", "hold", 72), "The buyer's card could not be reserved for the session on Friday, November 20 at 9:00 AM EST. We emailed them a link to pay by Tuesday, November 17 at 9:00 AM EST. If it is not paid by then, the session is canceled and its time opens again.");
is("canceled unpaid: at the cancellation deadline only after a failed hold with a deadline; otherwise when it was due to start", [fw("buyer", "cancel", "hold", 72), fw("creator", "cancel", "hold", 72), fw("buyer", "cancel", "hold", 0), fw("buyer", "cancel", "charge", 72)], ["Your session on Friday, November 20 at 9:00 AM EST was canceled at the cancellation deadline, because it was not paid. You were not charged for it.", "The session on Friday, November 20 at 9:00 AM EST was canceled at the cancellation deadline, because it was not paid. Nothing was charged, and its time is open again.", "Your session on Friday, November 20 at 9:00 AM EST was canceled when it was due to start, because it was not paid. You were not charged for it.", "Your session on Friday, November 20 at 9:00 AM EST was canceled when it was due to start, because it was not paid. You were not charged for it."]);
is("owed: asked to pay, never told its time is open again", [fw("buyer", "owed", "charge", 72), fw("creator", "owed", "charge", 72)], ["Your card could not be charged for your session on Friday, November 20 at 9:00 AM EST. Please pay what you owe with the link below.", "The buyer's card could not be charged for the session on Friday, November 20 at 9:00 AM EST. We emailed them a link to pay what they owe."]);
is("no deadline mentioned without a deadline", (["pay_by_link", "cancel", "owed"] as const).flatMap((w) => (["hold", "charge"] as const).map((st) => fw("buyer", w, st, 0))).some((t) => t.includes("deadline")), false);

part("Stopping sessions");
const rec = (index: number, status: IntentStatus | null, extra: Partial<ChargeRecord> = {}, h: Hold = { heldAt: null }): ChargeRecord => ({ index, cents: 8000, attempt: status === null ? 0 : 1, attemptAt: null, attemptBody: null, attemptKeyRefused: false, attemptFailed: false, intent: status === null ? null : intent(`pi_${index}`, status, h), refunded: false, kept: false, refused: [], tries: {}, ...extra });
const ended = starts[1] + HOUR;
const canceled = toCancel(starts, ended);
const SER = { id: "s1", application: "ca_platform", currency: "usd" };
const mc = (charge: SeriesCharge, record: ChargeRecord, start: number, deadlineHours: number, movedAt = NOW, found: FoundIntent[] = []) => moveCase(SER, record, found, { charge, start, deadlineHours, movedAt }).case;
const listed = (id: string, status: IntentStatus, session: number, h: Hold = { heldAt: null }, series = "s1", refunded = false, extra: Partial<FoundIntent> = {}): FoundIntent => ({
  ...intent(id, status, h),
  metadata: { mm_series: series, mm_session: String(session), ...(h.attempt ? { mm_attempt: String(h.attempt) } : {}) },
  amount: 8000,
  currency: "usd",
  application: "ca_platform",
  amountReceived: status === "succeeded" ? 8000 : 0,
  amountRefunded: refunded ? 8000 : 0,
  disputed: false,
  ...extra,
});
const by = (who: "creator" | "buyer", when: number, found: FoundIntent[] = [], s: readonly number[] = starts, deadlineHours = 48) => ({ series: SER, found, starts: s, at: when, by: who, deadlineHours, cents: 8000, cancelBy: s.map((x) => x - deadlineHours * HOUR) });
type Stop = ReturnType<typeof toStop>;
const S = (o: Partial<Stop> = {}): Stop => ({ never: [], close: [], refund: [], capture: [], charge: [], owed: [], pending: [], postpone: [], unrefundable: [], blocked: [], ...o });
const release = (id: string) => ({ id, action: "release" as const, key: `series:cancel:${id}:1` });
const cancel = (id: string) => ({ id, action: "cancel" as const, key: `series:cancel:${id}:1` });
const refund = (id: string, index: number, cents = 8000) => ({ id, index, key: `series:refund:${id}:1`, cents });
const capture = (id: string) => ({ id, key: `series:capture:${id}:1` });
const charge = (index: number, attempt: number, capture: "manual" | "automatic" = "automatic", body: Record<string, string> | null = null) => ({ index, attempt, key: `series:s1:${index}:${attempt}`, capture, body });
const stop = toStop(canceled, [rec(0, "succeeded"), rec(1, "succeeded"), rec(2, "requires_payment_method"), rec(3, "requires_capture", {}, { heldAt: with48[3].at })], by("buyer", ended));
is("ended in time: the failed charge's PaymentIntent is canceled and the hold released, so no pay link can charge them", stop, S({ never: [2, 3], close: [cancel("pi_2"), release("pi_3")] }));
is("an attempt with no id stored is read from the list; one never started needs nothing; a canceled one stays canceled; one captured is refunded when the creator stops it", toStop([0, 1, 2, 3], [rec(0, null, { attempt: 1 }), rec(1, null), rec(2, "canceled"), rec(3, "succeeded")], by("creator", BOOKED, [listed("pi_x", "requires_capture", 0, { heldAt: BOOKED })])), S({ never: [0, 1, 2, 3], close: [release("pi_x")], refund: [refund("pi_3", 3)] }));
is("every open state is canceled", (["requires_payment_method", "requires_confirmation", "requires_action"] as IntentStatus[]).map((st) => toStop([2], [rec(2, st)], by("buyer", ended)).close), [[cancel("pi_2")], [cancel("pi_2")], [cancel("pi_2")]]);
is("one processing is neither canceled nor refunded (Stripe allows neither): left and reported, decided again once it settles", toStop([2], [rec(2, "processing")], by("buyer", ended)), S({ never: [2], pending: [{ id: "pi_2", index: 2 }] }));
// The capture job has not run yet five minutes after session 2's deadline, and the buyer ends the series then.
const late = starts[2] - 48 * HOUR + 5 * 60_000;
const lateStop = toStop(toCancel(starts, late), [rec(0, "succeeded"), rec(1, "succeeded"), rec(2, "requires_capture", {}, { heldAt: with48[2].at }), rec(3, null)], by("buyer", late));
is("a buyer stopping after a session's deadline: its hold is captured, never released, and not refunded", [lateStop, toStop([2], [rec(2, "succeeded")], by("buyer", late)).refund], [S({ never: [3], capture: [capture("pi_2")] }), []]);
is("late, with no hold placed, with its hold canceled (expired or declined), or with an expired one: charged at once under the next attempt's key, never free", [toStop([2], [rec(2, null)], by("buyer", late)), toStop([2], [rec(2, "canceled")], by("buyer", late)), toStop([2], [rec(2, "requires_capture", {}, { heldAt: late - 5 * DAY })], by("buyer", late))], [S({ charge: [charge(2, 1)] }), S({ charge: [charge(2, 2)] }), S({ close: [release("pi_2")], charge: [charge(2, 2)] })]);
is("late, with an attempt not stored: the hold found on the list is captured; nothing found, charged at once", [toStop([2], [rec(2, null, { attempt: 1 })], by("buyer", late, [listed("pi_y", "requires_capture", 2, { heldAt: with48[2].at })])), toStop([2], [rec(2, null, { attempt: 1 })], by("buyer", late))], [S({ capture: [capture("pi_y")] }), S({ charge: [charge(2, 2)] })]);
is("late, with a failed charge after the deadline: left owed on its link", toStop([2], [rec(2, "requires_payment_method", {}, { heldAt: null, capture: "automatic" })], by("buyer", late)), S({ owed: ["pi_2"] }));
is("at the deadline itself the stop is in time, and the capture comes a minute after it", [toStop([2], [rec(2, "requires_capture", {}, { heldAt: with48[2].at })], by("buyer", starts[2] - 48 * HOUR)), captureTime(with48[2], at(with48[2].at), starts[2] - 48 * HOUR).at > starts[2] - 48 * HOUR], [S({ never: [2], close: [release("pi_2")] }), true]);
is("the creator stopping late still releases the hold", toStop([2], [rec(2, "requires_capture", {}, { heldAt: with48[2].at })], by("creator", late)), S({ never: [2], close: [release("pi_2")] }));
is("a late unpaid hold is closed: its link ended at the deadline", toStop([2], [rec(2, "requires_payment_method")], by("buyer", late)), S({ never: [2], close: [cancel("pi_2")] }));
is("late, with a payment found besides its hold: the payment stays and the hold is released, never both", toStop([2], [rec(2, "requires_capture", {}, { heldAt: with48[2].at })], by("buyer", late, [listed("pi_dup", "succeeded", 2)])), S({ close: [release("pi_2")] }));

part("Refunds are taken from the PaymentIntents listed for the series");
const auto = { heldAt: null, capture: "automatic" as const };
is("a second payment for the same session (a retry that made another) is refunded too: both when the creator stops it or the buyer stops it in time", [toStop([2], [rec(2, "succeeded")], by("creator", ended, [listed("pi_dup", "succeeded", 2)])).refund, toStop([2], [rec(2, "succeeded")], by("buyer", ended, [listed("pi_dup", "succeeded", 2, auto)])).refund], [[refund("pi_2", 2), refund("pi_dup", 2)], [refund("pi_2", 2), refund("pi_dup", 2)]]);
is("after a late stop the buyer keeps paying for one payment only, the one stored; any other is refunded", toStop([2], [rec(2, "succeeded")], by("buyer", late, [listed("pi_2", "succeeded", 2), listed("pi_dup", "succeeded", 2)])), S({ refund: [refund("pi_dup", 2)] }));
// The PaymentIntent was created and paid, and the process stopped before its id was stored.
is("a payment whose id was never stored is found on the list and refunded", toStop([2], [rec(2, null, { attempt: 1 })], by("creator", ended, [listed("pi_z", "succeeded", 2, auto)])), S({ never: [2], refund: [refund("pi_z", 2)] }));
is("never stored, the buyer stopping in time: a charge made before the deadline is refunded; a captured hold (captured only at or after its deadline) is kept", [toStop([2], [rec(2, null, { attempt: 1 })], by("buyer", ended, [listed("pi_z", "succeeded", 2, { ...auto, created: BOOKED })])).refund, toStop([2], [rec(2, null, { attempt: 1 })], by("buyer", ended, [listed("pi_z", "succeeded", 2)])).refund], [[refund("pi_z", 2)], []]);
is("another series' or session's payments are never refunded here", toStop([2], [rec(2, null)], by("creator", ended, [listed("pi_a", "succeeded", 3), listed("pi_b", "succeeded", 2, { heldAt: null }, "s2")])).refund, []);
is("a payment refunded already, on the list or on the record, is never refunded again", [toStop([2], [rec(2, null, { attempt: 1 })], by("creator", ended, [listed("pi_z", "succeeded", 2, auto, "s1", true)])).refund, toStop([2], [rec(2, "succeeded", { refunded: true })], by("creator", ended)).refund], [[], []]);
const many = toStop([2, 3], [rec(2, "succeeded"), rec(3, "succeeded")], by("creator", ended, [listed("pi_d2", "succeeded", 2), listed("pi_d3", "succeeded", 3)]));
is("one key per PaymentIntent refunded, never one key for two refunds", [many.refund.map((r) => r.key), new Set(many.refund.map((r) => r.key)).size, stepKey("refund", "pi_a") === stepKey("refund", "pi_b"), stepKey("refund", "pi_a") === stepKey("capture", "pi_a")], [["series:refund:pi_2:1", "series:refund:pi_d2:1", "series:refund:pi_3:1", "series:refund:pi_d3:1"], 4, false, false]);
is("a duplicate processing beside a payment is reported, not refunded until it settles, and never counted paid", toStop([2], [rec(2, "succeeded")], by("creator", ended, [listed("pi_p", "processing", 2)])), S({ never: [2], refund: [refund("pi_2", 2)], pending: [{ id: "pi_p", index: 2 }] }));
is("late, with only a payment processing: nothing charged, captured or owed until it settles", toStop([2], [rec(2, "requires_payment_method", {}, auto)], by("buyer", late, [listed("pi_p", "processing", 2, auto)])), S({ close: [cancel("pi_2")], pending: [{ id: "pi_p", index: 2 }] }));
is("late, with a good hold and a duplicate processing: the hold is neither captured nor released while it stays good, the duplicate reported", toStop([2], [rec(2, "requires_capture", {}, { heldAt: with48[2].at })], by("buyer", late, [listed("pi_p", "processing", 2, auto)])), S({ pending: [{ id: "pi_p", index: 2 }], postpone: [{ id: "pi_2", index: 2, until: holdGoodUntil(with48[2].at, null) }] }));
const every = [stop, lateStop, many, toStop([2], [rec(2, "requires_capture", {}, { heldAt: late - 5 * DAY })], by("buyer", late))];
is("every call toStop asks for carries its key", every.every((o) => o.close.every((c) => typeof c.key === "string" && c.key.length > 0) && o.capture.every((c) => c.key.length > 0) && o.charge.every((c) => c.key.length > 0) && o.refund.every((r) => r.key.length > 0)), true);
is("a session already started when it is stopped took place: nothing done for it", toStop([1], [rec(1, "succeeded")], by("creator", ended)), S());

part("Canceled for non-payment only on the list just read");
is("a link paid a moment ago keeps the session: held, processing or paid", (["requires_capture", "processing", "succeeded"] as IntentStatus[]).map((st) => unpaidCancel(SER, rec(2, "requires_payment_method"), [listed("pi_2", st, 2)], BOOKED).do), ["keep", "keep", "keep"]);
is("still unpaid on the list: canceled, its PaymentIntents closed, each under its key", [unpaidCancel(SER, rec(2, "requires_payment_method"), [listed("pi_2", "requires_payment_method", 2)], BOOKED), unpaidCancel(SER, rec(2, null, { attempt: 1 }), [], BOOKED)], [{ do: "cancel", close: [cancel("pi_2")] }, { do: "cancel", close: [] }]);

part("The pay link re-checks the session");
const link = { stopped: false, status: "requires_payment_method" as IntentStatus | null, now: starts[2] - 80 * HOUR, payBy: payBy(starts[2], 72, "hold") };
is("open while the session stands and the deadline has not come", payLink(link), "pay");
is("refused once the session is stopped, even inside the deadline", payLink({ ...link, stopped: true }), "stopped");
is("refused once its PaymentIntent is canceled", payLink({ ...link, status: "canceled" }), "closed");
is("nothing to pay without a PaymentIntent", payLink({ ...link, status: null }), "none");
is("refused from its time on", payLink({ ...link, now: starts[2] - 72 * HOUR }), "late");
is("nothing to pay once reserved or paid", [payLink({ ...link, status: "requires_capture" }), payLink({ ...link, status: "succeeded" })], ["done", "done"]);
is("an owed charge stays payable after the start and after a late stop", payLink({ ...link, stopped: true, owed: true, now: starts[2] + DAY }), "pay");
is("after a stop in time a payment is refunded in full and a hold released; after a buyer's late stop both are kept", [paidAfterStop("succeeded"), paidAfterStop("requires_capture"), paidAfterStop("requires_action"), paidAfterStop("canceled"), paidAfterStop("succeeded", true), paidAfterStop("requires_capture", true)], ["refund_in_full", "release", "cancel", "none", "none", "capture"]);
is("as Stripe allows: one processing is waited on, never canceled or refunded; one refunded already, never again", [paidAfterStop("processing"), paidAfterStop("processing", true), paidAfterStop("succeeded", false, true)], ["wait", "wait", "none"]);

part("A retry days later never creates a second PaymentIntent");
const go = (charge = held, now = charge.at) => ({ charge, stopped: false, now });
is("the key carries the attempt", [chargeKey("s1", 3, 1), chargeKey("s1", 3, 2)], ["series:s1:3:1", "series:s1:3:2"]);
// The attempt was written, the PaymentIntent created, and the id never stored: 70 hours later the key may be gone, but the list still shows it.
is("an attempt with no id stored: the one found on the account is reused, whatever the key's age", chargeAttempt(SER, rec(2, null, { attempt: 1 }), [listed("pi_x", "requires_payment_method", 2)], go()), { do: "reuse", id: "pi_x", close: [] });
is("a stored one is reused", chargeAttempt(SER, rec(2, "requires_action"), [], go()), { do: "reuse", id: "pi_2", close: [] });
is("only PaymentIntents of this series and this session count", chargeAttempt(SER, rec(2, null), [listed("pi_a", "succeeded", 3), listed("pi_b", "succeeded", 2, { heldAt: null }, "s2")], go()), { do: "create", attempt: 1, key: "series:s1:2:1", capture: "manual", close: [] });
is("only canceled ones: a new one, under the next attempt's key", chargeAttempt(SER, rec(2, "canceled"), [listed("pi_2", "canceled", 2)], go()), { do: "create", attempt: 2, key: "series:s1:2:2", capture: "manual", close: [] });
is("from the deadline on, a new one is a charge at once, never a hold", chargeAttempt(SER, rec(2, "canceled"), [], go(held, held.captureAt)), { do: "create", attempt: 2, key: "series:s1:2:2", capture: "automatic", close: [] });
is("never anything new before the session's planned time: it waits until then, never earlier", [chargeAttempt(SER, rec(2, null), [], go(held, held.at - HOUR)), chargeAttempt(SER, rec(2, null), [], go(held, held.at))], [{ do: "wait", at: held.at, close: [] }, { do: "create", attempt: 1, key: "series:s1:2:1", capture: "manual", close: [] }]);
is("two found: the one furthest along is kept and the other closed (refunded if paid), each under its key", chargeAttempt(SER, rec(2, "requires_payment_method"), [listed("pi_new", "succeeded", 2), listed("pi_old", "succeeded", 2)], go()), { do: "reuse", id: "pi_new", close: [{ id: "pi_old", action: "refund_in_full", key: "series:refund:pi_old:1" }, cancel("pi_2")] });
is("a duplicate processing is waited on, never counted paid nor closed; one refunded already is left as it is", chargeAttempt(SER, rec(2, "succeeded"), [listed("pi_p", "processing", 2, auto), listed("pi_r", "succeeded", 2, auto, "s1", true)], go()), { do: "reuse", id: "pi_2", close: [{ id: "pi_p", action: "wait", key: null }] });
is("a hold good until the capture is reused", chargeAttempt(SER, rec(2, "requires_capture", {}, { heldAt: held.at }), [], go()), { do: "reuse", id: "pi_2", close: [] });
is("a hold the list shows without its charge keeps the hold time stored, never turning stale", chargeAttempt(SER, rec(2, "requires_capture", {}, { heldAt: held.at }), [listed("pi_2", "requires_capture", 2, { heldAt: null, created: held.at - 10 * DAY })], go()), { do: "reuse", id: "pi_2", close: [] });
is("a moved session's old hold that would not last is released, never reused: a new one is placed", chargeAttempt(SER, rec(2, "requires_capture", {}, { heldAt: held.at }), [], go(moved, held.at + HOUR)), { do: "wait", at: moved.at, close: [release("pi_2")] });
is("the moved session's new hold is placed at its planned time, the old one released", chargeAttempt(SER, rec(2, "requires_capture", {}, { heldAt: held.at }), [], go(moved, moved.at)), { do: "create", attempt: 2, key: "series:s1:2:2", capture: "manual", close: [release("pi_2")] });
is("stale is judged at the moment of capture: a capture job running late on a hold no longer good does not reuse it", chargeAttempt(SER, rec(2, "requires_capture", {}, { heldAt: held.at }), [], go(held, held.at + GOOD + 1)).do, "create");
is("a stopped session never gets a new one, even when its last was canceled", [chargeAttempt(SER, rec(3, "canceled"), [], { charge: with48[3], stopped: true, now: with48[3].at }), chargeAttempt(SER, rec(3, null), [], { charge: with48[3], stopped: true, now: with48[3].at })], [{ do: "stop" }, { do: "stop" }]);

part("Refunds when a series ends");
const paid = [rec(0, "succeeded"), rec(1, "succeeded"), rec(2, "succeeded")];
const ends = (when: number, who: "creator" | "buyer", records = paid, s: readonly number[] = starts, deadlineHours = 48) => toStop(toCancel(s, when), records, by(who, when, [], s, deadlineHours)).refund.map((r) => r.index);
is("the creator ending it refunds every session captured and not yet held", ends(starts[1] + HOUR, "creator"), [2]);
is("a session already held is never refunded", ends(starts[2] + HOUR, "creator"), []);
is("the buyer ending it at least the deadline before a session captured gets it back, the instant itself included; later, not", [ends(starts[2] - 48 * HOUR - 1, "buyer"), ends(starts[2] - 48 * HOUR, "buyer"), ends(starts[2] - 47 * HOUR, "buyer")], [[2], [2], []]);
is("a charge already refunded is never refunded again", ends(starts[1], "creator", [rec(2, "succeeded", { refunded: true }), rec(3, "succeeded")]), [3]);
is("only what was captured: a hold is released by toStop, never refunded, and one processing is waited on", ends(starts[1], "creator", [rec(2, "requires_capture"), rec(3, "processing")]), []);
is("a first session already inside the deadline when booked is never refunded by the buyer ending it, even at once", ends(BOOKED, "buyer", [rec(0, "succeeded")], lateFirst), []);
is("no deadline: a buyer canceling before the start is refunded what was captured", ends(BOOKED + HOUR, "buyer", [rec(0, "succeeded")], farFirst, 0), [0]);

const one = (record: ChargeRecord, start: number, when: number, who: "creator" | "buyer", found: FoundIntent[] = []) => sessionRefunded(record, found, { series: SER, start, at: when, by: who, deadlineHours: 48, cancelBy: start - 48 * HOUR }).map((r) => r.id);
is("a kept charge (made at or after the deadline) is never refunded to the buyer, even after a move; the creator canceling still refunds it", [one(rec(2, "succeeded", { kept: true }), starts[2] + 21 * DAY, starts[2] + 21 * DAY - 49 * HOUR, "buyer"), one(rec(2, "succeeded", { kept: true }), starts[2] + 21 * DAY, starts[2] + 21 * DAY - 49 * HOUR, "creator")], [[], ["pi_2"]]);
// Charged at its deadline, then the creator moves the session three weeks later, and a duplicate hold made before the move is captured after it.
const keptRecord = rec(2, "succeeded", { kept: keptOnCharge(rec(2, "requires_capture"), starts[2] - 48 * HOUR + CAPTURE_DELAY_MS, with48[2]) });
const movedLater = sessionCharge(2, starts[2] + 21 * DAY, BOOKED, 8000, 48, starts[2] - DAY, "creator");
is("a creator's move never clears kept: a capture after the move, before the new deadline, leaves it kept", [keptRecord.kept, keptOnCharge(keptRecord, starts[2] + DAY, movedLater), keptOnCharge(rec(2, "succeeded"), starts[2] + DAY, movedLater), keptOnCharge(rec(2, "succeeded"), starts[2] + 21 * DAY - 48 * HOUR, movedLater)], [true, true, false, true]);

part("One session canceled on its own");
is("the buyer canceling one captured session at least the deadline before it is refunded; later, not; the creator canceling it, always before it starts", [one(rec(2, "succeeded"), starts[2], starts[2] - 48 * HOUR, "buyer"), one(rec(2, "succeeded"), starts[2], starts[2] - 47 * HOUR, "buyer"), one(rec(2, "succeeded"), starts[2], starts[2] - HOUR, "creator"), one(rec(2, "succeeded"), starts[2], starts[2] + HOUR, "creator")], [["pi_2"], [], ["pi_2"], []]);
is("from what was found, never the record alone: a payment never stored is refunded, and a duplicate too", [one(rec(2, null, { attempt: 1 }), starts[2], starts[2] - 48 * HOUR, "buyer", [listed("pi_z", "succeeded", 2, auto)]), one(rec(2, "succeeded"), starts[2], starts[2] - HOUR, "creator", [listed("pi_dup", "succeeded", 2, auto)])], [["pi_z"], ["pi_2", "pi_dup"]]);

part("A request that died is sent again under its own key, never a second payment");
const body = { amount: "8000", currency: "usd", customer: "cus_1", payment_method: "pm_1", capture_method: "automatic", confirm: "true", off_session: "true", "metadata[mm_series]": "s1", "metadata[mm_session]": "2", "metadata[mm_attempt]": "1" };
const sent = (extra: Partial<ChargeRecord> = {}) => rec(2, null, { attempt: 1, attemptAt: held.at - HOUR, attemptBody: body, ...extra });
// The attempt was written and the create sent; the function died before Stripe answered, and the list does not show it yet.
is("the latest attempt unknown: the same key and the same body again, never the next attempt", chargeAttempt(SER, sent(), [], go()), { do: "repeat", attempt: 1, key: "series:s1:2:1", body });
is("once its PaymentIntent is known canceled, the next attempt; with nothing listed after Stripe's 24 hours, the next attempt too", [chargeAttempt(SER, sent(), [listed("pi_1", "canceled", 2, { heldAt: null, attempt: 1 })], go()).do, chargeAttempt(SER, sent({ attemptAt: held.at - 25 * HOUR }), [], go())], ["create", { do: "create", attempt: 2, key: "series:s1:2:2", capture: "manual", close: [] }]);
is("a PaymentIntent stored for the latest attempt is known: it is reused, never sent again", chargeAttempt(SER, sent({ intent: intent("pi_1", "requires_payment_method", { heldAt: null, attempt: 1 }) }), [], go()), { do: "reuse", id: "pi_1", close: [] });
is("a late stop with the latest attempt unknown: that attempt sent again, same key and body, never a second charge", toStop([2], [sent({ attemptAt: late - HOUR, attemptBody: { ...body, capture_method: "manual" } })], by("buyer", late)), S({ charge: [charge(2, 1, "manual", { ...body, capture_method: "manual" })] }));
is("the exact parameters stored are sent again, never parameters rebuilt; an idempotency_error on the key lets the list decide at once", [(chargeAttempt(SER, sent(), [], go()) as { body: unknown }).body, chargeAttempt(SER, sent({ attemptKeyRefused: true }), [], go())], [body, { do: "create", attempt: 2, key: "series:s1:2:2", capture: "manual", close: [] }]);
is("a non-payment cancel never runs while an attempt is in flight: it waits", unpaidCancel(SER, sent(), [], held.at), { do: "wait" });

part("Refunds: what is left, never a disputed or refused one again");
const partly = listed("pi_z", "succeeded", 2, auto, "s1", false, { amountRefunded: 3000 });
is("a payment refunded in part: what is left is refunded (the call carries no amount)", toStop([2], [rec(2, null, { attempt: 1 })], by("creator", ended, [partly])).refund, [refund("pi_z", 2, 5000)]);
is("refunded in full by its amounts: never again", toStop([2], [rec(2, null, { attempt: 1 })], by("creator", ended, [listed("pi_z", "succeeded", 2, auto, "s1", false, { amountRefunded: 8000 })])).refund, []);
is("a disputed charge, or one whose refund Stripe refused: reported, never sent again", [toStop([2], [rec(2, null, { attempt: 1 })], by("creator", ended, [listed("pi_z", "succeeded", 2, auto, "s1", false, { disputed: true })])), toStop([2], [rec(2, "succeeded", { refused: ["pi_2"] })], by("creator", ended)).unrefundable], [S({ never: [2], unrefundable: [{ id: "pi_z", index: 2, why: "disputed" }] }), [{ id: "pi_2", index: 2, why: "refused" }]]);
is("a disputed duplicate beside a payment is reported, never refunded", chargeAttempt(SER, rec(2, "succeeded"), [listed("pi_d", "succeeded", 2, auto, "s1", false, { disputed: true })], go()), { do: "reuse", id: "pi_2", close: [{ id: "pi_d", action: "report", key: null }] });

part("Never a hold captured beside a payment processing");
const goodHold = rec(2, "requires_capture", {}, { heldAt: held.at });
is("a good hold and one processing: no capture while the hold stays good; then it is released and the other decides", [chargeAttempt(SER, goodHold, [listed("pi_p", "processing", 2, auto)], go(held, held.captureAt + CAPTURE_DELAY_MS)), chargeAttempt(SER, goodHold, [listed("pi_p", "processing", 2, auto)], go(held, holdGoodUntil(held.at, null) + 1))], [{ do: "wait", at: holdGoodUntil(held.at, null) + 1, close: [] }, { do: "reuse", id: "pi_p", close: [release("pi_2")] }]);

part("A payment refunded in full is never counted paid");
const refundedDup = listed("pi_r", "succeeded", 2, auto, "s1", true);
is("a good hold beside a payment refunded in full is reused, never released for it", chargeAttempt(SER, goodHold, [refundedDup], go()), { do: "reuse", id: "pi_2", close: [] });
is("a late stop with only a payment refunded in full: its good hold is captured", toStop([2], [rec(2, "requires_capture", {}, { heldAt: with48[2].at })], by("buyer", late, [refundedDup])), S({ capture: [capture("pi_2")] }));

part("Only this series' own PaymentIntents count");
const theirs = [listed("pi_amt", "succeeded", 2, auto, "s1", false, { amount: 9000 }), listed("pi_cur", "succeeded", 2, auto, "s1", false, { currency: "eur" }), listed("pi_app", "succeeded", 2, auto, "s1", false, { application: "ca_other" }), { ...listed("pi_old", "succeeded", 2, auto), metadata: { series: "s1", session: "2" } }];
is("this session's metadata with another amount, currency or application: reported, never acted on, and no new charge", [toStop([2], [rec(2, null)], by("creator", ended, theirs)), chargeAttempt(SER, rec(2, null), theirs, go())], [S({ never: [2], blocked: [{ index: 2, why: "mismatch", ids: ["pi_amt", "pi_cur", "pi_app"] }] }), { do: "report", why: "mismatch", ids: ["pi_amt", "pi_cur", "pi_app"] }]);
is("metadata not prefixed is never read as this series'", chargeAttempt(SER, rec(2, null), theirs.slice(3), go()).do, "create");
is("an application listed as null is a mismatch, never a reason to charge again; a SeriesKey without a ca_ id charges nothing", [chargeAttempt(SER, rec(2, null), [listed("pi_nul", "requires_payment_method", 2, auto, "s1", false, { application: null })], go()), chargeAttempt({ ...SER, application: "acct_123" }, rec(2, null), [], go())], [{ do: "report", why: "mismatch", ids: ["pi_nul"] }, { do: "report", why: "config", ids: [] }]);
is("a listed object without its application is matched by the rest", toStop([2], [rec(2, null)], by("creator", ended, [listed("pi_na", "succeeded", 2, auto, "s1", false, { application: undefined })])).refund, [refund("pi_na", 2)]);
is("the metadata written on every PaymentIntent is prefixed", seriesMetadata("s1", 2, 3), { mm_series: "s1", mm_session: "2", mm_attempt: "3" });

part("A series never starts before it is booked");
is("a session at or before the booking: refused", [seriesCharges([BOOKED, BOOKED + 7 * DAY], 8000, BOOKED, LEAST, 48), seriesCharges([BOOKED - HOUR, BOOKED + 7 * DAY], 8000, BOOKED, LEAST, 48)], [null, null]);

part("The creator moving a session inside its deadline (owner, C2-62)");
const creatorMoved = sessionCharge(2, NOW + 30 * HOUR, BOOKED, 8000, 48, NOW, "creator");
is("only held at once and captured at the session's start, free to cancel until then", creatorMoved, { index: 2, cents: 8000, at: NOW, captureAt: NOW + 30 * HOUR, way: "hold", refundFee: false, movedBy: "creator", cancelBy: NOW + 30 * HOUR });
is("the buyer moving it there keeps today's rule: charged at once and kept", sessionCharge(2, NOW + 30 * HOUR, BOOKED, 8000, 48, NOW, "buyer"), { index: 2, cents: 8000, at: NOW, captureAt: NOW, way: "charge", refundFee: false, movedBy: "buyer", cancelBy: NOW - 18 * HOUR });
is("created as a hold, captured a minute after the start, never before it", [chargeAttempt(SER, rec(2, "canceled"), [], go(creatorMoved, NOW)), captureTime(creatorMoved, at(NOW), NOW + HOUR), captureTime(creatorMoved, at(NOW), NOW + 30 * HOUR)], [{ do: "create", attempt: 2, key: "series:s1:2:2", capture: "manual", close: [] }, { do: "capture", at: NOW + 30 * HOUR + CAPTURE_DELAY_MS }, { do: "capture", at: NOW + 30 * HOUR + CAPTURE_DELAY_MS }]);
const farMoved = sessionCharge(2, NOW + 70 * HOUR, BOOKED, 8000, 72, NOW, "creator");
is("a hold that would expire before the start is placed again inside its window, never captured early", [farMoved.way, farMoved.captureAt, captureTime(farMoved, at(NOW, NOW + 50 * HOUR), NOW + 40 * HOUR)], ["hold", NOW + 70 * HOUR, { do: "rehold", at: NOW + 40 * HOUR }]);
const cancelBy: number[] = [];
cancelBy[2] = creatorMoved.cancelBy;
const movedStarts = [...starts];
movedStarts[2] = NOW + 30 * HOUR;
is("the buyer canceling before the start: the hold is released, nothing charged, nothing kept; after the start's own time it is a late stop", [toStop([2], [rec(2, "requires_capture", {}, { heldAt: NOW })], { ...by("buyer", NOW + 29 * HOUR, [], movedStarts), cancelBy }), keptOnCharge(rec(2, "requires_capture"), NOW + HOUR, creatorMoved), keptOnCharge(rec(2, "requires_capture"), NOW + 30 * HOUR + CAPTURE_DELAY_MS, creatorMoved)], [S({ never: [2], close: [release("pi_2")] }), false, true]);
is("the change message follows the charge: held until the start, charged now, kept, or as before", [mc(creatorMoved, rec(2, null), NOW + 30 * HOUR, 48), mc(sessionCharge(2, NOW + 30 * HOUR, BOOKED, 8000, 48, NOW, "buyer"), rec(2, null), NOW + 30 * HOUR, 48), mc(creatorMoved, rec(2, "succeeded", { kept: true }), NOW + 30 * HOUR, 48), mc(sessionCharge(2, NOW + 5 * DAY, BOOKED, 8000, 48, NOW, "creator"), rec(2, null), NOW + 5 * DAY, 48), mc(sessionCharge(2, NOW + 10 * HOUR, BOOKED, 8000, 0, NOW, "creator"), rec(2, null), NOW + 10 * HOUR, 0)], ["held_until_start", "charged_now", "kept", "planned", "planned"]);

part("The change message, in every store language");
const moveCases = ["held_until_start", "planned", "kept", "charged_now", "paid_refundable_until", "pay_by_link"] as const;
const moveInput = { date: "Friday, November 20 at 9:00 AM EST", store: "Lena Coaching", hours: 48, by: "creator" as const, until: "Friday, November 20 at 8:59 AM EST" };
is("the buyer told in plain words what the creator's move inside the deadline does", seriesMoveMessage("en", "buyer", "held_until_start", moveInput), "Lena Coaching moved your session to Friday, November 20 at 9:00 AM EST. That is less than 48 hours away, so your card is only reserved now. It is charged when the session starts. Cancel any time before then and you pay nothing for it.");
is("the creator told the same, without the buyer's name", seriesMoveMessage("en", "creator", "held_until_start", moveInput), "You moved the session to Friday, November 20 at 9:00 AM EST. That is inside your 48-hour cancellation deadline, so the buyer's card is only reserved. It is charged when the session starts. If the buyer cancels before then, the reservation is released and nothing is charged.");
const everyMessage = LANGUAGE_CODES.flatMap((lang) => (["buyer", "creator"] as const).flatMap((to) => moveCases.flatMap((which) => (["creator", "buyer"] as const).flatMap((who) => [0, 48].map((hours) => ({ lang, to, which, lines: SERIES_MOVE_WORDS[lang][to][which]({ ...moveInput, by: who, hours }) }))))));
is("every language has every message for both sides, each with the date and no empty line", everyMessage.filter((m) => !m.lines.length || m.lines.some((l) => !l.trim()) || !m.lines[0].includes(moveInput.date)).map((m) => `${m.lang} ${m.to} ${m.which}`), []);
is("every sentence under 21 words, in every language", everyMessage.flatMap((m) => m.lines.filter((l) => l.split(/\s+/).length >= 21).map((l) => `${m.lang}: ${l}`)), []);
is("the seven languages, each its own words", [Object.keys(SERIES_MOVE_WORDS).sort(), new Set(LANGUAGE_CODES.map((l) => SERIES_MOVE_WORDS[l].buyer.held_until_start(moveInput).join(" "))).size], [[...LANGUAGE_CODES].sort(), 7]);
is("an unknown language reads as English", seriesMoveMessage("xx", "buyer", "kept", moveInput), seriesMoveMessage("en", "buyer", "kept", moveInput));

part("A payment refunded in full outside these rules is never charged again by itself");
is("its only payment refunded in full (by the creator in their dashboard): reported, no new PaymentIntent", [chargeAttempt(SER, rec(2, "succeeded", { refunded: true }), [], go()), chargeAttempt(SER, rec(2, null, { attempt: 1 }), [listed("pi_z", "succeeded", 2, auto, "s1", true)], go())], [{ do: "report", why: "refunded", ids: ["pi_2"] }, { do: "report", why: "refunded", ids: ["pi_z"] }]);
is("a late stop by the buyer then charges nothing: reported", toStop([2], [rec(2, "succeeded", { refunded: true })], by("buyer", late)), S({ blocked: [{ index: 2, why: "refunded", ids: ["pi_2"] }] }));

part("Every stop says each session's own last moment to cancel");
is("a stop without a session's cancelBy is refused, never read as the old deadline", (() => { try { toStop([2], [rec(2, null)], { ...by("buyer", ended), cancelBy: [] }); return false; } catch { return true; } })(), true);
const refundFeeRec = rec(0, "succeeded", {}, auto);
is("a paid session the creator moved inside its deadline: the buyer canceling before the start gets it back", sessionRefunded(refundFeeRec, [], { series: SER, start: NOW + 30 * HOUR, at: NOW + 29 * HOUR, by: "buyer", deadlineHours: 48, cancelBy: NOW + 30 * HOUR }), [refund("pi_0", 0)]);
is("at the start itself the session has started: a stop then does nothing for it", toStop([2], [rec(2, "requires_capture", {}, { heldAt: NOW })], { ...by("buyer", NOW + 30 * HOUR, [], movedStarts), cancelBy }), S());

part("A refund that failed in passing is tried again under a new key");
is("each try its own key; only a definitive refusal stops the tries", [toStop([2], [rec(2, "succeeded", { tries: { "refund:pi_2": 2 } })], by("creator", ended)).refund, toStop([2], [rec(2, "succeeded", { tries: { "refund:pi_2": 2 }, refused: ["pi_2"] })], by("creator", ended)).unrefundable], [[{ id: "pi_2", index: 2, key: "series:refund:pi_2:3", cents: 8000 }], [{ id: "pi_2", index: 2, why: "refused" }]]);

part("The change message for a session paid already");
is("paid and not kept: refundable until its cancelBy; paid with its cancelBy passed: kept", [mc(creatorMoved, refundFeeRec, NOW + 30 * HOUR, 48), mc(sessionCharge(0, NOW + 30 * HOUR, BOOKED, 8000, 48, NOW, "buyer"), refundFeeRec, NOW + 30 * HOUR, 48), mc(sessionCharge(0, NOW + 5 * DAY, BOOKED, 8000, 48, NOW, "creator"), refundFeeRec, NOW + 5 * DAY, 48)], ["paid_refundable_until", "kept", "paid_refundable_until"]);
is("said to the buyer and the creator", [seriesMoveMessage("en", "buyer", "paid_refundable_until", moveInput), seriesMoveMessage("en", "creator", "paid_refundable_until", moveInput)], ["Lena Coaching moved your session to Friday, November 20 at 9:00 AM EST. This session was already charged. Cancel by Friday, November 20 at 8:59 AM EST and it is refunded in full.", "You moved the session to Friday, November 20 at 9:00 AM EST. The buyer was already charged for it. If the buyer cancels by Friday, November 20 at 8:59 AM EST, they get a full refund."]);
is("a kept charge is said as already charged, however it was made", seriesMoveMessage("en", "buyer", "kept", moveInput).includes("This session was already charged. That charge stays"), true);

part("A mismatch is read before anything else");
const other = listed("pi_m", "succeeded", 2, auto, "s1", false, { amount: 9000, amountReceived: 9000 });
is("a good hold beside a paid mismatch is never reused or captured: reported", chargeAttempt(SER, goodHold, [other], go()), { do: "report", why: "mismatch", ids: ["pi_m"] });
is("a late stop with a good hold beside a mismatch: the hold is neither captured nor released, both reported", toStop([2], [rec(2, "requires_capture", {}, { heldAt: with48[2].at })], by("buyer", late, [other])), S({ postpone: [{ id: "pi_2", index: 2, until: holdGoodUntil(with48[2].at, null) }], blocked: [{ index: 2, why: "mismatch", ids: ["pi_m"] }] }));
is("never canceled as unpaid beside a mismatch: reported", unpaidCancel(SER, rec(2, "requires_payment_method"), [other], BOOKED), { do: "report", why: "mismatch", ids: ["pi_m"] });
is("a mismatch refunded in full, or canceled, stops blocking", [chargeAttempt(SER, rec(2, null), [listed("pi_m", "succeeded", 2, auto, "s1", false, { amount: 9000, amountReceived: 9000, amountRefunded: 9000 })], go()).do, chargeAttempt(SER, rec(2, null), [listed("pi_m", "canceled", 2, auto, "s1", false, { amount: 9000 })], go()).do], ["create", "create"]);

part("A buyer's move inside the deadline keeps a paid session kept");
const paidFirst = rec(0, "succeeded", {}, auto);
const movedStarts0 = [...starts];
movedStarts0[0] = NOW + 30 * HOUR;
const buyerIn = sessionCharge(0, NOW + 30 * HOUR, BOOKED, 8000, 48, NOW, "buyer");
const afterBuyer = { ...paidFirst, kept: keptOnMove(SER, paidFirst, [], buyerIn) };
const creatorOut = sessionCharge(0, NOW + 10 * DAY, BOOKED, 8000, 48, NOW + HOUR, "creator");
const laterStarts = [...starts];
laterStarts[0] = NOW + 10 * DAY;
is("moved in by the buyer: kept; moved out by the creator: still kept, said so; canceled then by the buyer: not refunded", [afterBuyer.kept, keptOnMove(SER, afterBuyer, [], creatorOut), mc(creatorOut, afterBuyer, NOW + 10 * DAY, 48), toStop([0], [afterBuyer], by("buyer", NOW + 2 * DAY, [], laterStarts)).refund], [true, true, "kept", []]);
is("the creator moving a paid session inside the deadline never makes it kept", keptOnMove(SER, paidFirst, [], sessionCharge(0, NOW + 30 * HOUR, BOOKED, 8000, 48, NOW, "creator")), false);

part("Never a pay link for what the creator refunded");
is("an open PaymentIntent beside a payment refunded in full outside these rules: reported, never reused", chargeAttempt(SER, rec(2, "requires_payment_method", {}, auto), [listed("pi_r", "succeeded", 2, auto, "s1", true)], go()), { do: "report", why: "refunded", ids: ["pi_r"] });

part("A failed payment when the session is moved");
is("its payment failed: the pay link message, never \"only reserved\"", [mc(creatorMoved, rec(2, "requires_payment_method"), NOW + 30 * HOUR, 48), mc(creatorMoved, rec(2, "requires_action"), NOW + 30 * HOUR, 48)], ["pay_by_link", "pay_by_link"]);
is("said to the buyer", seriesMoveMessage("en", "buyer", "pay_by_link", moveInput), "Lena Coaching moved your session to Friday, November 20 at 9:00 AM EST. Your payment for it has not gone through yet. Pay with the link by Friday, November 20 at 8:59 AM EST. If it is not paid by then, the session is canceled and you are not charged.");

part("Attempts and their keys");
const flagged = { ...sent({ attemptKeyRefused: true }) };
const next = startAttempt(flagged, held.at, body);
is("a new attempt: the next number, its time, exactly its parameters, attemptKeyRefused back to false", [next.attempt, next.attemptAt, next.attemptBody, next.attemptKeyRefused], [2, held.at, body, false]);
is("a parameter off the allow-list is refused (no mandate_data with an IP address)", (() => { try { startAttempt(flagged, held.at, { ...body, "mandate_data[customer_acceptance][online][ip_address]": "1.2.3.4" }); return false; } catch { return true; } })(), true);
is("in flight (409) waits; other parameters let the list decide; anything else failed", [createErrorStep("idempotency_key_in_use"), createErrorStep("idempotency_error"), createErrorStep("card_declined")], ["wait", "decide_from_list", "failed"]);

part("A refund's answer");
is("already refunded is done; a dispute or a request error refused for good; a passing error tried again", [refundOutcome(null), refundOutcome({ code: "charge_already_refunded", status: 400 }), refundOutcome({ code: "charge_disputed", status: 400 }), refundOutcome({ code: "parameter_invalid_integer", status: 400 }), refundOutcome({ status: 500 }), refundOutcome({ code: "rate_limit", status: 429 }), refundOutcome({ code: "lock_timeout", status: 400 }), refundOutcome({})], ["done", "done", "refused", "refused", "retry", "retry", "retry", "retry"]);

part("A session moved after its payment failed");
const failedHold = rec(2, "requires_payment_method");
const buyerInside = sessionCharge(2, NOW + 30 * HOUR, BOOKED, 8000, 48, NOW, "buyer");
is("the buyer moves it inside its deadline: the failed hold is canceled and the session charged now, said so", [chargeAttempt(SER, failedHold, [], go(buyerInside, NOW)), mc(buyerInside, failedHold, NOW + 30 * HOUR, 48)], [{ do: "create", attempt: 2, key: "series:s1:2:2", capture: "automatic", close: [cancel("pi_2")] }, "charged_now"]);
const laterPlan = sessionCharge(2, starts[2] + 7 * DAY, BOOKED, 8000, 48, NOW);
is("moved later: the failed one is canceled and the session planned again at its time, said so", [chargeAttempt(SER, failedHold, [], go(laterPlan, NOW)), mc(laterPlan, failedHold, starts[2] + 7 * DAY, 48)], [{ do: "wait", at: laterPlan.at, close: [cancel("pi_2")] }, "planned"]);
is("the pay link's time is payBy of the step that failed, never a cancelBy already passed", [moveCase(SER, failedHold, [], { charge: creatorMoved, start: NOW + 30 * HOUR, deadlineHours: 48, movedAt: NOW }), moveCase(SER, rec(2, "requires_payment_method", {}, auto), [], { charge: sessionCharge(2, NOW + 60 * HOUR, BOOKED, 8000, 48, NOW, "creator"), start: NOW + 60 * HOUR, deadlineHours: 48, movedAt: NOW })], [{ case: "pay_by_link", until: NOW + 30 * HOUR }, { case: "pay_by_link", until: NOW + 60 * HOUR }]);

part("A create refused for good with no PaymentIntent");
is("never sent again, never waited on: an unconfirmed PaymentIntent for the pay link, and the non-payment cancel runs", [chargeAttempt(SER, sent({ attemptFailed: true }), [], go()), unpaidCancel(SER, sent({ attemptFailed: true }), [], held.at).do, startAttempt(sent({ attemptFailed: true }), held.at, body).attemptFailed], [{ do: "link", attempt: 2, key: "series:s1:2:2", capture: "manual", close: [] }, "cancel", false]);
is("the parameters an off-session charge on a saved card needs are allowed", (() => { try { startAttempt(sent(), held.at, { ...body, return_url: "https://example.com/r", "automatic_payment_methods[enabled]": "true", "automatic_payment_methods[allow_redirects]": "never", "payment_method_types[0]": "card" }); return true; } catch { return false; } })(), true);

part("Never canceled as unpaid what the creator refunded");
is("a payment refunded in full outside these rules: reported, never \"you were not charged\"", unpaidCancel(SER, rec(2, "succeeded", { refunded: true }), [], BOOKED), { do: "report", why: "refunded", ids: ["pi_2"] });

part("Kept only by a charge made before the stop was accepted");
is("a charge made after the moment the stop was accepted never keeps it", toStop([2], [rec(2, "succeeded", { kept: true }, { heldAt: ended + HOUR, capture: "automatic" })], by("buyer", ended)).refund, [refund("pi_2", 2)]);

part("Captures and cancels tried again under a new key");
is("each try its own key", [toStop([2], [rec(2, "requires_capture", { tries: { "capture:pi_2": 1 } }, { heldAt: with48[2].at })], by("buyer", late)).capture, toStop([2], [rec(2, "requires_capture", { tries: { "cancel:pi_2": 2 } }, { heldAt: with48[2].at })], by("creator", late)).close], [[{ id: "pi_2", key: "series:capture:pi_2:2" }], [{ id: "pi_2", action: "release", key: "series:cancel:pi_2:3" }]]);

part("A move reads the PaymentIntents listed");
is("a payment found only on the list keeps a session the buyer moved inside its deadline", keptOnMove(SER, rec(0, null, { attempt: 1 }), [listed("pi_z", "succeeded", 0, auto)], buyerIn), true);

part("Not with a deposit, a code or a package");
is("refused, each said", [seriesBillingProblem({ deposit: true, code: false, fromPackage: false }), seriesBillingProblem({ deposit: false, code: true, fromPackage: false }), seriesBillingProblem({ deposit: false, code: false, fromPackage: true }), seriesBillingProblem({ deposit: false, code: false, fromPackage: false })], ["deposit", "code", "package", null]);

part("What the buyer agrees to before booking");
const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const dates = ["Friday, November 6 at 9:00 AM EST", "Friday, November 13 at 9:00 AM EST", "Friday, November 20 at 9:00 AM EST", "Friday, November 27 at 9:00 AM EST"];
const said = seriesChargeWords({ charges: with48, starts, dates, money, store: "Lena Coaching", bookedAt: BOOKED, deadlineHours: 48 });
is("the count and total from the charges, the dates, the saved card, when each is reserved and charged, a failed card, canceling, the creator canceling", said, "You book 4 sessions for $320 in all. The dates: Friday, November 6 at 9:00 AM EST; Friday, November 13 at 9:00 AM EST; Friday, November 20 at 9:00 AM EST; Friday, November 27 at 9:00 AM EST. Your card is saved with Lena Coaching's payment account and used without you there, as described here. For each session, $80 is reserved on your card a day before the cancellation deadline. It is charged at the deadline, 48 hours before the session starts. For the first session, it is reserved now. If your card cannot be reserved, we email you a link to pay. Pay by the cancellation deadline, or that session is canceled and you are not charged. If the charge at the deadline fails, the link works until the session starts. If it is not paid by then, that session is canceled and you are not charged. Cancel a session at least 48 hours before it starts and you pay nothing for it. The reservation is released, and anything already charged is refunded. If you cancel later or miss it, it is not refunded. If you cancel later and its charge failed, you still owe it. Once a session is charged at or after its deadline, it is not refunded, even if its time changes later. If you move a session to less than 48 hours away, it is charged at once and not refunded. If Lena Coaching moves a session not charged yet closer than 48 hours, your card is only reserved. It is charged when the session starts, and you can cancel for free until then. If Lena Coaching cancels, you get back what was charged for every session that does not take place. This does not affect your rights under the law.");
const lateSaid = seriesChargeWords({ charges: seriesCharges(lateFirst, 8000, BOOKED, LEAST, 48)!, starts: lateFirst, dates: ["a", "b"], money, store: "Lena Coaching", bookedAt: BOOKED, deadlineHours: 48 });
is("a first session already inside the deadline: charged now and not refunded, said", lateSaid.includes("The first session starts in less than 48 hours, so it is charged now and not refunded if you cancel."), true);
is("a first session charged directly: said", seriesChargeWords({ charges: seriesCharges(farFirst, 8000, BOOKED, LEAST, 48)!, starts: farFirst, dates: ["a", "b"], money, store: "Lena Coaching", bookedAt: BOOKED, deadlineHours: 48 }).includes("The first session is charged now."), true);
const noneSaid = seriesChargeWords({ charges: none, starts, dates, money, store: "Lena Coaching", bookedAt: BOOKED });
is("no deadline: reserved a day before, charged at the start, cancel any time before it", [noneSaid.includes("$80 is reserved on your card a day before it starts. It is charged when the session starts."), noneSaid.includes("Cancel a session any time before it starts and you pay nothing for it."), noneSaid.includes("Pay before the session starts, or it is canceled and you are not charged."), noneSaid.includes("If the charge when it starts fails, we email you a link to pay it."), noneSaid.includes("deadline")], [true, true, true, true, false]);
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
