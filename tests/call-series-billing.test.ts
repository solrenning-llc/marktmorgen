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
  CAPTURE_DELAY_MS,
  captureTime,
  chargeAttempt,
  holdGoodUntil,
  keptWhen,
  unpaidCancel,
  payBy,
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
type Hold = { heldAt: number | null; captureBefore?: number | null; created?: number; capture?: "manual" | "automatic" };
const intent = (id: string, status: IntentStatus, h: Hold = { heldAt: null }) => ({ id, status, capture: h.capture ?? ("manual" as const), created: h.created ?? BOOKED, heldAt: h.heldAt, captureBefore: h.captureBefore ?? null });
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
is("moved inside its deadline: never planned in the past, charged at once and not refunded to a buyer canceling", [inside.at >= NOW && inside.captureAt >= NOW, inside], [true, { index: 2, cents: 8000, at: NOW, captureAt: NOW, way: "charge", refundFee: false }]);
is("moved inside its deadline with a hold still good: that hold is captured at once, not left uncaptured", captureTime(inside, at(NOW - 2 * HOUR), NOW), { do: "capture", at: NOW });
is("moved to a day after its deadline would come: held now, captured at the deadline", sessionCharge(2, NOW + 60 * HOUR, BOOKED, 8000, 48, NOW), { index: 2, cents: 8000, at: NOW, captureAt: NOW + 12 * HOUR, way: "hold", refundFee: false });
is("a first session moved later is held a day before its deadline like the others, never charged early", sessionCharge(0, NOW + 20 * DAY, BOOKED, 8000, 48, NOW), { index: 0, cents: 8000, at: NOW + 20 * DAY - 72 * HOUR, captureAt: NOW + 20 * DAY - 48 * HOUR, way: "hold", refundFee: false });
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
const rec = (index: number, status: IntentStatus | null, extra: Partial<ChargeRecord> = {}, h: Hold = { heldAt: null }): ChargeRecord => ({ index, cents: 8000, attempt: status === null ? 0 : 1, intent: status === null ? null : intent(`pi_${index}`, status, h), refunded: false, kept: false, ...extra });
const ended = starts[1] + HOUR;
const canceled = toCancel(starts, ended);
const by = (who: "creator" | "buyer", when: number, found: ReturnType<typeof listed>[] = []) => ({ seriesId: "s1", found, starts, at: when, by: who, deadlineHours: 48 });
const listed = (id: string, status: IntentStatus, session: number, h: Hold = { heldAt: null }, series = "s1") => ({ ...intent(id, status, h), metadata: { series, session: String(session) } });
const stop = toStop(canceled, [rec(0, "succeeded"), rec(1, "succeeded"), rec(2, "requires_payment_method"), rec(3, "requires_capture", {}, { heldAt: with48[3].at })], by("buyer", ended));
is("ended in time: the failed charge's PaymentIntent is canceled and the hold released, so no pay link can charge them", stop, { never: [2, 3], close: [{ id: "pi_2", action: "cancel" }, { id: "pi_3", action: "release" }], capture: [], charge: [], owed: [] });
is("an attempt with no id stored is read from the list; one never started needs nothing; a canceled one stays canceled; one captured is left to the refund rule", toStop([0, 1, 2, 3], [rec(0, null, { attempt: 1 }), rec(1, null), rec(2, "canceled"), rec(3, "succeeded")], by("creator", BOOKED, [listed("pi_x", "requires_capture", 0, { heldAt: BOOKED })])), { never: [0, 1, 2], close: [{ id: "pi_x", action: "release" }], capture: [], charge: [], owed: [] });
is("every open state is canceled, and a processing one too (refunded in full if it still succeeds)", (["requires_payment_method", "requires_confirmation", "requires_action", "processing"] as IntentStatus[]).map((st) => toStop([2], [rec(2, st)], by("buyer", ended)).close), [[{ id: "pi_2", action: "cancel" }], [{ id: "pi_2", action: "cancel" }], [{ id: "pi_2", action: "cancel" }], [{ id: "pi_2", action: "cancel" }]]);
// The capture job has not run yet five minutes after session 2's deadline, and the buyer ends the series then.
const late = starts[2] - 48 * HOUR + 5 * 60_000;
const lateStop = toStop(toCancel(starts, late), [rec(0, "succeeded"), rec(1, "succeeded"), rec(2, "requires_capture", {}, { heldAt: with48[2].at }), rec(3, null)], by("buyer", late));
is("a buyer stopping after a session's deadline: its hold is captured, never released, and not refunded", [lateStop, refundsOnEnd([rec(2, "succeeded")], starts, late, "buyer", 48).length], [{ never: [3], close: [], capture: ["pi_2"], charge: [], owed: [] }, 0]);
is("late, with no hold placed, with its hold canceled (expired or declined), or with an expired one: charged at once, never free", [toStop([2], [rec(2, null)], by("buyer", late)), toStop([2], [rec(2, "canceled")], by("buyer", late)), toStop([2], [rec(2, "requires_capture", {}, { heldAt: late - 5 * DAY })], by("buyer", late))], [{ never: [], close: [], capture: [], charge: [2], owed: [] }, { never: [], close: [], capture: [], charge: [2], owed: [] }, { never: [], close: [{ id: "pi_2", action: "release" }], capture: [], charge: [2], owed: [] }]);
is("late, with an attempt not stored: the hold found on the list is captured; nothing found, charged at once", [toStop([2], [rec(2, null, { attempt: 1 })], by("buyer", late, [listed("pi_y", "requires_capture", 2, { heldAt: with48[2].at })])), toStop([2], [rec(2, null, { attempt: 1 })], by("buyer", late))], [{ never: [], close: [], capture: ["pi_y"], charge: [], owed: [] }, { never: [], close: [], capture: [], charge: [2], owed: [] }]);
is("late, with a failed charge after the deadline: left owed on its link", toStop([2], [rec(2, "requires_payment_method", {}, { heldAt: null, capture: "automatic" })], by("buyer", late)), { never: [], close: [], capture: [], charge: [], owed: ["pi_2"] });
is("at the deadline itself the stop is in time, and the capture comes a minute after it", [toStop([2], [rec(2, "requires_capture", {}, { heldAt: with48[2].at })], by("buyer", starts[2] - 48 * HOUR)), captureTime(with48[2], at(with48[2].at), starts[2] - 48 * HOUR).at > starts[2] - 48 * HOUR], [{ never: [2], close: [{ id: "pi_2", action: "release" }], capture: [], charge: [], owed: [] }, true]);
is("the creator stopping late still releases the hold", toStop([2], [rec(2, "requires_capture", {}, { heldAt: with48[2].at })], by("creator", late)), { never: [2], close: [{ id: "pi_2", action: "release" }], capture: [], charge: [], owed: [] });
is("a late unpaid hold is closed: its link ended at the deadline", toStop([2], [rec(2, "requires_payment_method")], by("buyer", late)), { never: [2], close: [{ id: "pi_2", action: "cancel" }], capture: [], charge: [], owed: [] });
is("a duplicate is closed too: refunded if paid", toStop([2], [rec(2, "requires_capture", {}, { heldAt: with48[2].at })], by("buyer", late, [listed("pi_dup", "succeeded", 2)])), { never: [], close: [{ id: "pi_2", action: "release" }], capture: [], charge: [], owed: [] });

part("Canceled for non-payment only on the list just read");
is("a link paid a moment ago keeps the session: held, processing or paid", (["requires_capture", "processing", "succeeded"] as IntentStatus[]).map((st) => unpaidCancel("s1", rec(2, "requires_payment_method"), [listed("pi_2", st, 2)]).do), ["keep", "keep", "keep"]);
is("still unpaid on the list: canceled, its PaymentIntents closed", [unpaidCancel("s1", rec(2, "requires_payment_method"), [listed("pi_2", "requires_payment_method", 2)]), unpaidCancel("s1", rec(2, null, { attempt: 1 }), [])], [{ do: "cancel", close: ["pi_2"] }, { do: "cancel", close: [] }]);

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

part("A retry days later never creates a second PaymentIntent");
const go = (charge = held, now = charge.at) => ({ charge, stopped: false, now });
is("the key carries the attempt", [chargeKey("s1", 3, 1), chargeKey("s1", 3, 2)], ["series:s1:3:1", "series:s1:3:2"]);
// The attempt was written, the PaymentIntent created, and the id never stored: 70 hours later the key may be gone, but the list still shows it.
is("an attempt with no id stored: the one found on the account is reused, whatever the key's age", chargeAttempt("s1", rec(2, null, { attempt: 1 }), [listed("pi_x", "requires_payment_method", 2)], go()), { do: "reuse", id: "pi_x", close: [] });
is("a stored one is reused", chargeAttempt("s1", rec(2, "requires_action"), [], go()), { do: "reuse", id: "pi_2", close: [] });
is("only PaymentIntents of this series and this session count", chargeAttempt("s1", rec(2, null), [listed("pi_a", "succeeded", 3), listed("pi_b", "succeeded", 2, { heldAt: null }, "s2")], go()), { do: "create", attempt: 1, key: "series:s1:2:1", capture: "manual", close: [] });
is("only canceled ones: a new one, under the next attempt's key", chargeAttempt("s1", rec(2, "canceled"), [listed("pi_2", "canceled", 2)], go()), { do: "create", attempt: 2, key: "series:s1:2:2", capture: "manual", close: [] });
is("from the deadline on, a new one is a charge at once, never a hold", chargeAttempt("s1", rec(2, "canceled"), [], go(held, held.captureAt)), { do: "create", attempt: 2, key: "series:s1:2:2", capture: "automatic", close: [] });
is("two found: the one furthest along is kept and the other closed (refunded if paid)", chargeAttempt("s1", rec(2, "requires_payment_method"), [listed("pi_new", "succeeded", 2), listed("pi_old", "succeeded", 2)], go()), { do: "reuse", id: "pi_new", close: [{ id: "pi_old", action: "refund_in_full" }, { id: "pi_2", action: "cancel" }] });
is("a hold good until the capture is reused", chargeAttempt("s1", rec(2, "requires_capture", {}, { heldAt: held.at }), [], go()), { do: "reuse", id: "pi_2", close: [] });
is("a hold the list shows without its charge keeps the hold time stored, never turning stale", chargeAttempt("s1", rec(2, "requires_capture", {}, { heldAt: held.at }), [listed("pi_2", "requires_capture", 2, { heldAt: null, created: held.at - 10 * DAY })], go()), { do: "reuse", id: "pi_2", close: [] });
is("a moved session's old hold that would not last is released, never reused: a new one is placed", chargeAttempt("s1", rec(2, "requires_capture", {}, { heldAt: held.at }), [], go(moved, held.at + HOUR)), { do: "create", attempt: 2, key: "series:s1:2:2", capture: "manual", close: [{ id: "pi_2", action: "release" }] });
is("stale is judged at the moment of capture: a capture job running late on a hold no longer good does not reuse it", chargeAttempt("s1", rec(2, "requires_capture", {}, { heldAt: held.at }), [], go(held, held.at + GOOD + 1)).do, "create");
is("a stopped session never gets a new one, even when its last was canceled", [chargeAttempt("s1", rec(3, "canceled"), [], { charge: with48[3], stopped: true, now: with48[3].at }), chargeAttempt("s1", rec(3, null), [], { charge: with48[3], stopped: true, now: with48[3].at })], [{ do: "stop" }, { do: "stop" }]);

part("Refunds when a series ends");
const paid = [rec(0, "succeeded"), rec(1, "succeeded"), rec(2, "succeeded")];
is("the creator ending it refunds every session captured and not yet held", refundsOnEnd(paid, starts, starts[1] + HOUR, "creator", 48).map((c) => c.index), [2]);
is("a session already held is never refunded", refundsOnEnd(paid, starts, starts[2] + HOUR, "creator", 48).map((c) => c.index), []);
is("the buyer ending it at least the deadline before a session captured gets it back, the instant itself included; later, not", [refundsOnEnd(paid, starts, starts[2] - 48 * HOUR - 1, "buyer", 48).map((c) => c.index), refundsOnEnd(paid, starts, starts[2] - 48 * HOUR, "buyer", 48).map((c) => c.index), refundsOnEnd(paid, starts, starts[2] - 47 * HOUR, "buyer", 48).map((c) => c.index)], [[2], [2], []]);
is("a charge already refunded is never refunded again", refundsOnEnd([rec(2, "succeeded", { refunded: true }), rec(3, "succeeded")], starts, starts[1], "creator", 48).map((c) => c.index), [3]);
is("only what was captured: a hold is released by toStop, never refunded", refundsOnEnd([rec(2, "requires_capture"), rec(3, "processing")], starts, starts[1], "creator", 48), []);
is("a first session already inside the deadline when booked is never refunded by the buyer ending it, even at once", refundsOnEnd([rec(0, "succeeded")], lateFirst, BOOKED, "buyer", 48), []);
is("no deadline: a buyer canceling before the start is refunded what was captured", refundsOnEnd([rec(0, "succeeded")], farFirst, BOOKED + HOUR, "buyer", 0).map((c) => c.index), [0]);

is("a kept charge (made at or after the deadline) is never refunded to the buyer, even after a move; the creator canceling still refunds it", [sessionRefunded(rec(2, "succeeded", { kept: true }), starts[2] + 21 * DAY, starts[2] + 21 * DAY - 49 * HOUR, "buyer", 48), sessionRefunded(rec(2, "succeeded", { kept: true }), starts[2] + 21 * DAY, starts[2] + 21 * DAY - 49 * HOUR, "creator", 48)], [false, true]);

part("One session canceled on its own");
is("the buyer canceling one captured session at least the deadline before it is refunded; later, not; the creator canceling it, always before it starts", [sessionRefunded(rec(2, "succeeded"), starts[2], starts[2] - 48 * HOUR, "buyer", 48), sessionRefunded(rec(2, "succeeded"), starts[2], starts[2] - 47 * HOUR, "buyer", 48), sessionRefunded(rec(2, "succeeded"), starts[2], starts[2] - HOUR, "creator", 48), sessionRefunded(rec(2, "succeeded"), starts[2], starts[2] + HOUR, "creator", 48)], [true, false, true, false]);

part("Not with a deposit, a code or a package");
is("refused, each said", [seriesBillingProblem({ deposit: true, code: false, fromPackage: false }), seriesBillingProblem({ deposit: false, code: true, fromPackage: false }), seriesBillingProblem({ deposit: false, code: false, fromPackage: true }), seriesBillingProblem({ deposit: false, code: false, fromPackage: false })], ["deposit", "code", "package", null]);

part("What the buyer agrees to before booking");
const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const dates = ["Friday, November 6 at 9:00 AM EST", "Friday, November 13 at 9:00 AM EST", "Friday, November 20 at 9:00 AM EST", "Friday, November 27 at 9:00 AM EST"];
const said = seriesChargeWords({ charges: with48, starts, dates, money, store: "Lena Coaching", bookedAt: BOOKED, deadlineHours: 48 });
is("the count and total from the charges, the dates, the saved card, when each is reserved and charged, a failed card, canceling, the creator canceling", said, "You book 4 sessions for $320 in all. The dates: Friday, November 6 at 9:00 AM EST; Friday, November 13 at 9:00 AM EST; Friday, November 20 at 9:00 AM EST; Friday, November 27 at 9:00 AM EST. Your card is saved with Lena Coaching's payment account and used without you there, as described here. For each session, $80 is reserved on your card a day before the cancellation deadline. It is charged at the deadline, 48 hours before the session starts. For the first session, it is reserved now. If your card cannot be reserved, we email you a link to pay. Pay by the cancellation deadline, or that session is canceled and you are not charged. If the charge at the deadline fails, the link works until the session starts. If it is not paid by then, that session is canceled and you are not charged. Cancel a session at least 48 hours before it starts and you pay nothing for it. The reservation is released, and anything already charged is refunded. If you cancel later or miss it, it is not refunded. If Lena Coaching cancels, you get back what was charged for every session that does not take place. This does not affect your rights under the law.");
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
