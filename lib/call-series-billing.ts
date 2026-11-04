/**
 * How a recurring series of one call is charged (637 [GL5], unit 5b; added
 * 3 November 2026, reworked 4 November 2026 after two reviews): the rules,
 * browser-safe. Saving the buyer's card on the creator's Stripe account,
 * placing each hold, capturing, canceling and refunding are the next units
 * (lib/call-series-rules.ts has the dates and toCancel). Nothing calls these
 * rules yet.
 *
 * Sources read on 4 November 2026 (docs.stripe.com):
 *   - payments/place-a-hold-on-a-payment-method: a card authorization
 *     (capture_method=manual), card not present, lasts 7 days for
 *     Mastercard, American Express and Discover, and for a Visa one the
 *     customer started; a Visa merchant-initiated one lasts "5 days",
 *     exactly "4 days and 18 hours, to allow time for clearing processes".
 *     No other brand is listed, and Stripe may class an off-session payment
 *     either way, so every hold is counted at the shortest listed window
 *     (AUTH_WINDOW_HOURS) unless Stripe says when it expires (the charge's
 *     capture_before). An expired hold is released and its PaymentIntent
 *     turns canceled.
 *   - api/idempotent_requests: keys "can be removed automatically after
 *     they're at least 24 hours old"; a key reused after that makes a new
 *     request. So a key alone never guards a retry days later (chargeAttempt).
 *   - search: data is searchable "in under 1 minute" and search is not for
 *     read-after-write; the list APIs have no such delay. So a retry lists
 *     the buyer's PaymentIntents on the connected account, never searches.
 *
 *   - Each session is paid on its own, at the length's own price, with the
 *     card the buyer saves on the creator's own Stripe account when booking
 *     the series. The deadline is the cancellation deadline promised when
 *     booking, one of SERIES_DEADLINES (520 [LB1], unit 7a: the same list as
 *     CANCEL_HOURS in lib/call-setup.ts), or none, read as zero hours: the
 *     session's start.
 *   - Each session after the first: HOLD_LEAD_HOURS before its deadline the
 *     amount is only reserved on the card (a hold), and it is captured at
 *     the deadline. A buyer canceling before the deadline has the hold
 *     canceled: nothing charged, nothing refunded, no fee lost
 *     (sessionCharge). The cadence is a week or more and the deadline 72
 *     hours at most, so no two captures ever fall together.
 *   - The first session at booking, with the buyer there: a hold now,
 *     captured at its deadline, when that is within HOLD_MAX_HOURS; charged
 *     at once when its deadline has already passed (nothing left to cancel
 *     for free); and, only when the hold would not last until the deadline,
 *     charged at once with `refundFee` true: a buyer canceling in time is
 *     refunded, and the fee Stripe keeps on a refunded charge is a cost the
 *     margin table reads from that flag. No later session ever needs it.
 *   - A session moved within the rules is worked out again from its new
 *     start and from the moment it was moved, never planned in the past:
 *     moved inside its deadline, it is charged at once and not refunded to
 *     a buyer canceling, as for a first session booked inside it.
 *   - Every capture falls inside its hold's window: a hold is captured only
 *     while it is valid less CAPTURE_MARGIN_HOURS, counted from Stripe's
 *     capture_before, or from the hold's own time when Stripe did not say
 *     (or from its PaymentIntent's creation, earlier, when even that is
 *     unknown). It is captured CAPTURE_DELAY_MS after the deadline, so a
 *     cancellation at the deadline itself, which counts as in time, is
 *     always decided first. A hold that would not last until then (an old
 *     one, a session moved later) is released and placed again before the
 *     deadline, and charged at once instead from the deadline on; a capture
 *     is never moved earlier than the deadline (captureTime).
 *   - A hold that fails (a card refused, or the bank asking the buyer to
 *     confirm): the buyer is emailed a link to pay, valid only until the
 *     deadline. Unpaid by then, the session is canceled at the deadline, its
 *     time freed, nothing charged. A capture that fails at the deadline (a
 *     hold that expired or was declined) is no fault of the buyer: the
 *     amount is charged at once, off-session; if that fails too, the link
 *     works until the session starts, and unpaid it is canceled at its
 *     start. A charge that fails once the session has started never cancels
 *     a session that took place: what is owed stays on the pay link. Both
 *     sides are told each step (failedCharge, failedChargeWords).
 *   - A charge made at or after the deadline (a capture, a charge at once,
 *     a first session booked inside it, a session moved inside it) is kept:
 *     never refunded to the buyer, even if the session is moved later, by
 *     the buyer or by the creator (keptWhen, keptOnCharge, ChargeRecord.kept:
 *     a move never clears it); the creator canceling still refunds it.
 *   - Whether a session was charged is read from its PaymentIntents' state,
 *     never from the time it was due. When sessions are canceled (a series
 *     ending, or one session), toStop says, for each, what is done, from the
 *     PaymentIntents listed for the series by their metadata, so one whose
 *     id was never stored, or a second one made for the same session, is
 *     dealt with too: never charged and its open PaymentIntents closed (a
 *     hold released, a failed one canceled); or, when the buyer stopped it
 *     after its deadline, its hold captured, or charged at once when no hold
 *     is left to capture, or its failed late charge left owed on the pay
 *     link: a late cancellation is paid, as promised. One processing is
 *     never counted paid: Stripe can neither refund nor cancel it, so it is
 *     left, reported, and decided again once it has settled. The pay link
 *     re-reads the session before it shows anything (payLink). A payment
 *     that still succeeds for a session stopped in time is refunded in full
 *     by itself, and a hold placed for one is released (paidAfterStop).
 *   - The payments refunded when sessions are canceled are toStop's list
 *     (sessionRefunded for one session): every one that succeeded for a
 *     session not yet started and was not refunded already. The creator
 *     canceling refunds them all. The buyer canceling keeps paying for one
 *     only: after the session's deadline (the instant itself is in time, as
 *     520 [LB1] promises), or a kept charge; any second payment for the same
 *     session is always refunded. Only a payment that succeeded is refunded;
 *     a hold is released, never refunded.
 *   - Not with a deposit, a discount code or a package: their figures are one
 *     booking's. Each session's price is the length chosen (lib/call-lengths.ts).
 *   - The words a buyer agrees to before booking (seriesChargeWords) are
 *     worked out from the charges and refuse charges that are not the plan.
 *     Before they are shown, the booking unit checks against Stripe's and the
 *     card networks' official, dated rules what an agreement to future
 *     charges on a saved card must say, and adds it.
 *   - Every sentence here is the US English source. The seven store
 *     languages follow in the unit that shows them.
 *
 * What the unit that charges must do, so nothing here is promised that it
 * cannot keep:
 *   - Create every PaymentIntent with the buyer's `customer` and metadata
 *     series and session, under chargeKey, with capture_method as
 *     chargeAttempt says; write the attempt to the session's record under
 *     its lock before creating it, and the PaymentIntent's id, status,
 *     capture method, creation, hold time and capture_before as soon as
 *     Stripe answers; set `kept` with keptOnCharge on every capture or
 *     charge, never with keptWhen alone, and never clear it on a move.
 *   - Send every call under its key: a new PaymentIntent under chargeKey
 *     (toStop's charges carry theirs), and a capture, cancel or refund of
 *     an existing one under stepKey, one key per PaymentIntent and step, so
 *     a key is never reused for another PaymentIntent's refund.
 *   - Before creating, confirming, capturing, canceling, releasing or
 *     refunding anything (toStop's steps, its refunds and the non-payment
 *     cancel included), list
 *     the buyer's PaymentIntents on the connected account, every page
 *     (has_more), with expand[]=data.latest_charge so each hold's time and
 *     capture_before come with it, and decide again with them
 *     (chargeAttempt, toStop, unpaidCancel), right before every capture
 *     too, so a duplicate hold made by a racing attempt is closed and never
 *     captured as well, and a link paid a moment ago is never canceled.
 *   - Take every decision under the series' lock, after reading the
 *     session again: a stopped one takes only what toStop says.
 */

/** The deadlines a series may be charged at: the creator's cancellation deadlines, all shorter than a week. Zero or none: the session's start. */
export const SERIES_DEADLINES = [2, 12, 24, 48, 72] as const;
/** A session's hold is placed this long before its capture. */
export const HOLD_LEAD_HOURS = 24;
/** The shortest card-not-present authorization window Stripe lists: Visa, merchant-initiated, 4 days and 18 hours. */
export const AUTH_WINDOW_HOURS = 4 * 24 + 18;
/** Kept between a capture and the hold's expiry (Stripe's own delayed capture keeps about 6 hours). */
export const CAPTURE_MARGIN_HOURS = 6;
/** The longest a hold is planned to wait for its capture: well inside AUTH_WINDOW_HOURS less the margin. */
export const HOLD_MAX_HOURS = 96;
/** A hold is captured this long after the deadline, so a cancellation at the deadline itself (in time) is decided first. */
export const CAPTURE_DELAY_MS = 60_000;
const HOUR = 3_600_000;

export type SeriesCharge = {
  index: number;
  cents: number;
  /** When the hold is placed, or the amount charged at once when `way` is "charge". */
  at: number;
  /** When it is captured: the deadline before the session. The same as `at` when `way` is "charge". */
  captureAt: number;
  way: "hold" | "charge";
  /** Charged before the buyer's last moment to cancel for free: a refund in time loses Stripe's fee. The margin table reads it. */
  refundFee: boolean;
};

/** The deadline as hours before the session: 0 for none, null when it is not one of SERIES_DEADLINES. */
export function readDeadline(hours: unknown): number | null {
  if (hours === undefined || hours === null || hours === 0) return 0;
  return (SERIES_DEADLINES as readonly unknown[]).includes(hours) ? (hours as number) : null;
}

/** The deadline before a session: the last moment to cancel it for free, to pay a failed hold, and its capture. */
export function deadlineOf(start: number, deadlineHours: number): number {
  return start - deadlineHours * HOUR;
}

/**
 * How one session is paid, from its start as it is now (a moved session's
 * new start), never before the booking nor before `now` (the moment it is
 * worked out: the booking, or the move). `deadlineHours` as readDeadline
 * returns it.
 */
export function sessionCharge(index: number, start: number, bookedAt: number, cents: number, deadlineHours: number, now = bookedAt): SeriesCharge {
  const from = Math.max(bookedAt, now);
  const captureAt = Math.max(from, deadlineOf(start, deadlineHours));
  // The first, at booking, is held with the buyer there; any other (or a first moved later), a day before its deadline.
  const at = index === 0 && from === bookedAt ? bookedAt : Math.max(from, captureAt - HOLD_LEAD_HOURS * HOUR);
  // The deadline already passed (at booking, or by a move inside it): charged at once, and never refunded to a buyer canceling.
  if (captureAt === at) return { index, cents, at, captureAt: at, way: "charge", refundFee: false };
  // A hold would not last until the deadline (only a first session far from its booking): charged at once, refunded if canceled in time.
  if (captureAt - at > HOLD_MAX_HOURS * HOUR) return { index, cents, at, captureAt: at, way: "charge", refundFee: true };
  return { index, cents, at, captureAt, way: "hold", refundFee: false };
}

/**
 * When each session is held and captured, and how much. Null when the
 * amount is not a whole positive number of the currency's smallest unit at
 * or above `least` (the currency's smallest charge, lib/money.ts), or the
 * deadline is not one of SERIES_DEADLINES.
 */
export function seriesCharges(starts: readonly number[], cents: number, bookedAt: number, least: number, deadlineHours?: number): SeriesCharge[] | null {
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents < least) return null;
  const deadline = readDeadline(deadlineHours);
  if (deadline === null) return null;
  return starts.map((start, index) => sessionCharge(index, start, bookedAt, cents, deadline));
}

/** When a hold stops being safe to capture: Stripe's capture_before, or the shortest listed window from the hold's own time when Stripe did not say, less the margin. */
export function holdGoodUntil(heldAt: number, captureBefore: number | null): number {
  return (captureBefore ?? heldAt + AUTH_WINDOW_HOURS * HOUR) - CAPTURE_MARGIN_HOURS * HOUR;
}

/** When a session is captured, worked out at `now`: CAPTURE_DELAY_MS after its deadline (or at once, once that has passed); a session charged at once, at once. */
export function captureMoment(charge: SeriesCharge, now: number): number {
  return charge.way === "hold" ? Math.max(charge.captureAt + CAPTURE_DELAY_MS, now) : Math.max(charge.at, now);
}

/**
 * What to do with a session's hold at `now`: capture it at captureMoment
 * while it is still good then. Otherwise, before the deadline, release it and
 * place a new one at the planned time (or now); from the deadline on, or for
 * a session now charged at once (moved inside its deadline), charge at once
 * instead, never placing a hold after the deadline. Never a capture at or
 * after the hold's expiry, and never earlier than the deadline.
 */
export function captureTime(charge: SeriesCharge, hold: Intent, now: number): { do: "capture"; at: number } | { do: "rehold"; at: number } | { do: "charge_now"; at: number } {
  const good = holdGoodUntil(holdTime(hold), hold.captureBefore);
  const at = captureMoment(charge, now);
  if (at <= good) return { do: "capture", at };
  if (charge.way === "charge" || now >= charge.captureAt) return { do: "charge_now", at: now };
  return { do: "rehold", at: Math.max(now, charge.at) };
}

/**
 * What a failed payment step comes to. `step` is what failed: the hold
 * (the link works until the deadline, then the session is canceled there);
 * the capture at the deadline (no fault of the buyer: charged at once,
 * off-session); or that charge (the link works until the session starts,
 * then it is canceled at its start; once it has started, the session took
 * place and what is owed stays on the link, never canceled).
 */
export function failedCharge(start: number, now: number, deadlineHours: number, step: "hold" | "capture" | "charge"): "pay_by_link" | "charge_now" | "cancel" | "owed" {
  if (step === "capture") return "charge_now";
  if (now < payBy(start, deadlineHours, step)) return "pay_by_link";
  return step === "charge" ? "owed" : "cancel";
}

/** Until when the link to pay works after a failed hold (the deadline) or a failed charge at the deadline (the session's start). */
export function payBy(start: number, deadlineHours: number, step: "hold" | "charge"): number {
  return step === "hold" ? deadlineOf(start, deadlineHours) : start;
}

/** Whether a capture or charge made at `chargedAt` is kept: made at or after the deadline before the session's start then, it is never refunded to the buyer. */
export function keptWhen(chargedAt: number, start: number, deadlineHours: number): boolean {
  return chargedAt >= deadlineOf(start, deadlineHours);
}

/** A PaymentIntent's status, as Stripe names it. */
export type IntentStatus = "requires_payment_method" | "requires_confirmation" | "requires_action" | "processing" | "requires_capture" | "succeeded" | "canceled";

/**
 * A session's PaymentIntent as last read: `capture` its capture_method
 * (manual for a hold), `created` its creation, `heldAt` its latest charge's
 * creation and `captureBefore` that charge's, when known.
 */
export type Intent = { id: string; status: IntentStatus; capture: "manual" | "automatic"; created: number; heldAt: number | null; captureBefore: number | null };

/** When a hold was placed: its charge's time, or its PaymentIntent's creation (earlier, so never later than the truth) when unknown. */
function holdTime(intent: Intent): number {
  return intent.heldAt ?? intent.created;
}

/** One session's record, kept by the unit that charges. */
export type ChargeRecord = {
  index: number;
  cents: number;
  /** How many PaymentIntents were started for it, written under the lock before each is created; 0 when never. */
  attempt: number;
  /** The latest one, stored as soon as Stripe answers; null until then. */
  intent: Intent | null;
  /** Its charge was refunded in full already. */
  refunded: boolean;
  /** Its charge was made at or after the deadline (keptWhen): never refunded to the buyer. */
  kept: boolean;
};

/** The key one attempt is created under on the creator's Stripe account. Kept by Stripe for about 24 hours only: a later retry relies on chargeAttempt. */
export function chargeKey(seriesId: string, index: number, attempt: number): string {
  return `series:${seriesId}:${index}:${attempt}`;
}

/** The key a step on an existing PaymentIntent is sent under: one per PaymentIntent and step, so no key is ever sent again for another PaymentIntent's refund, capture or cancel. Releasing a hold is canceling its PaymentIntent. */
export function stepKey(step: "capture" | "cancel" | "refund", id: string): string {
  return `series:${step}:${id}`;
}

/**
 * Whether a capture or charge that succeeded at `chargedAt` leaves the
 * session's charge kept, the session starting at `start` then. Never clears
 * `kept`: a charge kept before the session was moved stays kept after it,
 * whoever moved it (a creator's move is not the buyer's choice, and never
 * the buyer canceling in time), and the creator canceling still refunds it.
 */
export function keptOnCharge(record: ChargeRecord, chargedAt: number, start: number, deadlineHours: number): boolean {
  return record.kept || keptWhen(chargedAt, start, deadlineHours);
}

/**
 * A PaymentIntent as listed on the connected account (with
 * expand[]=data.latest_charge): `refunded` when its latest charge was
 * refunded at all (`refunded`, or `amount_refunded` above zero), so it is
 * never refunded again.
 */
export type FoundIntent = Intent & { metadata: Record<string, string | undefined>; refunded: boolean };

/** A session's PaymentIntent as decided on: the record's and the list's merged. */
export type Live = Intent & { refunded: boolean };

const RANK: IntentStatus[] = ["succeeded", "requires_capture", "processing", "requires_action", "requires_confirmation", "requires_payment_method"];

/**
 * A session's PaymentIntents that are not canceled, furthest along first
 * (a payment not refunded before one refunded): the record's merged with
 * those listed for this series and session. The listed status wins; a hold
 * time or capture_before the list did not carry is kept from the record.
 */
export function sessionIntents(seriesId: string, record: ChargeRecord, found: readonly FoundIntent[]): Live[] {
  const mine = new Map<string, Live>();
  if (record.intent) mine.set(record.intent.id, { ...record.intent, refunded: record.refunded });
  for (const f of found) {
    if (f.metadata.series !== seriesId || f.metadata.session !== String(record.index)) continue;
    const stored = mine.get(f.id);
    mine.set(f.id, {
      id: f.id,
      status: f.status,
      capture: f.capture,
      created: f.created,
      heldAt: f.heldAt ?? stored?.heldAt ?? null,
      captureBefore: f.captureBefore ?? stored?.captureBefore ?? null,
      refunded: f.refunded || (stored?.refunded ?? false),
    });
  }
  return [...mine.values()].filter((i) => i.status !== "canceled").sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status) || Number(a.refunded) - Number(b.refunded));
}

/**
 * A PaymentIntent closed, with the key its call is sent under: a payment
 * refunded in full, a hold released or an open one canceled (both a cancel
 * on Stripe). `wait`: one processing, which Stripe neither refunds nor
 * cancels: left, reported, and decided again once it has settled (refunded
 * if it succeeds); no call, no key.
 */
export type Close = { id: string; action: "refund_in_full" | "release" | "cancel" | "wait"; key: string | null };

function closeStep(id: string, action: Close["action"]): Close {
  return { id, action, key: action === "wait" ? null : stepKey(action === "refund_in_full" ? "refund" : "cancel", id) };
}

/**
 * Whether to reuse a PaymentIntent for a session, create one, wait, or do
 * nothing, at `now`: `found` is the buyer's PaymentIntents listed on the
 * creator's account, every page (the list API, never search). A stopped
 * session never gets a new one. A hold that would not be good at its
 * capture moment is released, never reused. Any other one is reused, the
 * furthest along first, and the rest closed (paidAfterStop says how; one
 * processing is waited on, never counted paid). With none left, nothing new
 * before the session's planned time (`wait`, at that time, never earlier);
 * from it, one is created under the next attempt's key: a hold before the
 * deadline, a charge at once from it on (never a hold after the deadline).
 */
export function chargeAttempt(
  seriesId: string,
  record: ChargeRecord,
  found: readonly FoundIntent[],
  input: { charge: SeriesCharge; stopped: boolean; now: number },
): { do: "stop" } | { do: "reuse"; id: string; close: Close[] } | { do: "wait"; at: number; close: Close[] } | { do: "create"; attempt: number; key: string; capture: "manual" | "automatic"; close: Close[] } {
  if (input.stopped) return { do: "stop" };
  const live = sessionIntents(seriesId, record, found);
  const moment = captureMoment(input.charge, input.now);
  const stale = (i: Intent) => i.status === "requires_capture" && holdGoodUntil(holdTime(i), i.captureBefore) < moment;
  const usable = live.filter((i) => !stale(i));
  const close = (keep: string | null) =>
    live.flatMap((i) => {
      if (i.id === keep) return [];
      const action = stale(i) ? "release" : paidAfterStop(i.status, false, i.refunded);
      return action === "none" || action === "capture" ? [] : [closeStep(i.id, action)];
    });
  if (usable.length) return { do: "reuse", id: usable[0].id, close: close(usable[0].id) };
  if (input.now < input.charge.at) return { do: "wait", at: input.charge.at, close: close(null) };
  const attempt = record.attempt + 1;
  const capture = input.charge.way === "hold" && input.now < input.charge.captureAt ? "manual" : "automatic";
  return { do: "create", attempt, key: chargeKey(seriesId, record.index, attempt), capture, close: close(null) };
}

/**
 * Whether a session is canceled for non-payment (at the deadline, or at its
 * start after a failed charge), decided on the PaymentIntents just listed,
 * never on the record alone: a link paid a moment ago (held, processing or
 * paid) keeps the session; otherwise it is canceled and its open
 * PaymentIntents canceled, each under its own key.
 */
export function unpaidCancel(seriesId: string, record: ChargeRecord, found: readonly FoundIntent[]): { do: "keep" } | { do: "cancel"; close: Close[] } {
  const live = sessionIntents(seriesId, record, found);
  if (live.some((i) => i.status === "succeeded" || i.status === "requires_capture" || i.status === "processing")) return { do: "keep" };
  return { do: "cancel", close: live.map((i) => closeStep(i.id, "cancel")) };
}

export type AfterStop = "refund_in_full" | "release" | "capture" | "cancel" | "wait" | "none";

/**
 * What is done with a session's PaymentIntent once the session is stopped,
 * including a payment that comes in after. `paid` is true when the buyer
 * stopped it after its deadline: then what was paid is kept and a hold is
 * captured, as a late cancellation is paid. As Stripe allows: only a payment
 * that succeeded is refunded, and never one refunded already; a hold is
 * released (canceled), never refunded; one processing is waited on.
 */
export function paidAfterStop(status: IntentStatus, paid = false, refunded = false): AfterStop {
  if (status === "canceled") return "none";
  if (status === "succeeded") return paid || refunded ? "none" : "refund_in_full";
  if (status === "requires_capture") return paid ? "capture" : "release";
  if (status === "processing") return "wait";
  // Still open (unpaid or awaiting the buyer): canceled. If it still succeeds, the rule above decides.
  return "cancel";
}

/** A payment refunded in full when sessions are stopped, under its own key. */
export type Refund = { id: string; index: number; key: string };

/**
 * Whether a paid PaymentIntent is kept from the buyer: the record's `kept`
 * for the one stored; for one never stored (found only on the list), a
 * captured hold always (a hold is captured only at or after its deadline),
 * a charge at once when it was made at or after the deadline.
 */
function keptCharge(i: Live, record: ChargeRecord, start: number, deadlineHours: number): boolean {
  if (record.intent?.id === i.id) return record.kept;
  return i.capture === "manual" || keptWhen(holdTime(i), start, deadlineHours);
}

/**
 * What stopping canceled sessions at `at` does, decided on the
 * PaymentIntents just listed for the series (`found`, every page, by their
 * metadata) merged with the records, so a PaymentIntent whose id was never
 * stored, or a second one made for the same session, is found and dealt
 * with too. Each step carries the key its call is sent under.
 *   - `refund`: every payment for a stopped session that succeeded and was
 *     not refunded already, except the one the buyer keeps paying for (a
 *     late stop by the buyer, or a kept charge); a duplicate always.
 *   - `close`: holds released and open PaymentIntents canceled; never a
 *     refund, and never one processing.
 *   - `pending`: those processing, which Stripe can neither refund nor
 *     cancel: never counted paid, reported, and decided again once they
 *     have settled (refunded if they succeed, as a duplicate or a payment
 *     for a session stopped in time).
 *   - `never`: each session that must never be charged.
 *   - For sessions the buyer stopped after their deadline (a late
 *     cancellation is paid), when nothing was paid: `capture`, a hold still
 *     good to capture; or nothing new while one is processing; or `owed`, a
 *     failed late charge left on its pay link; or, for a failed hold whose
 *     link ended at the deadline, nothing (the session goes unpaid, as
 *     failedCharge says); else `charge`, charged at once under the next
 *     attempt's key (no hold placed, or one canceled or expired).
 * A session already started at `at` took place and is not stopped here.
 */
export function toStop(
  canceled: readonly number[],
  records: readonly ChargeRecord[],
  input: { seriesId: string; found: readonly FoundIntent[]; starts: readonly number[]; at: number; by: "creator" | "buyer"; deadlineHours: number },
): { never: number[]; close: Close[]; refund: Refund[]; capture: { id: string; key: string }[]; charge: { index: number; attempt: number; key: string }[]; owed: string[]; pending: { id: string; index: number }[] } {
  const byIndex = new Map(records.map((r) => [r.index, r]));
  const out = { never: [] as number[], close: [] as Close[], refund: [] as Refund[], capture: [] as { id: string; key: string }[], charge: [] as { index: number; attempt: number; key: string }[], owed: [] as string[], pending: [] as { id: string; index: number }[] };
  for (const index of canceled) {
    const start = input.starts[index];
    if (!(start > input.at)) continue;
    const record = byIndex.get(index) ?? { index, cents: 0, attempt: 0, intent: null, refunded: false, kept: false };
    const live = sessionIntents(input.seriesId, record, input.found);
    // After the deadline, by the buyer: paid. At the deadline itself, in time.
    const late = input.by === "buyer" && input.at > deadlineOf(start, input.deadlineHours);
    const paid = live.filter((i) => i.status === "succeeded");
    // The one payment the buyer keeps paying for: after a late stop, or a kept charge; never when the creator stopped it.
    const stays = input.by === "buyer" ? paid.find((i) => !i.refunded && (late || keptCharge(i, record, start, input.deadlineHours))) : undefined;
    for (const i of paid) if (!i.refunded && i.id !== stays?.id) out.refund.push({ id: i.id, index, key: stepKey("refund", i.id) });
    const processing = live.filter((i) => i.status === "processing");
    for (const i of processing) out.pending.push({ id: i.id, index });
    const holds = live.filter((i) => i.status === "requires_capture");
    const open = live.filter((i) => i.status !== "succeeded" && i.status !== "requires_capture" && i.status !== "processing");
    let keep: string | null = null;
    if (late && !paid.length) {
      const good = holds.find((h) => holdGoodUntil(holdTime(h), h.captureBefore) >= input.at);
      const owes = open.find((i) => i.capture === "automatic");
      if (good) {
        out.capture.push({ id: good.id, key: stepKey("capture", good.id) });
        keep = good.id;
      } else if (processing.length) {
        // Nothing new while one is processing: decided again once it has settled.
      } else if (owes) {
        out.owed.push(owes.id);
        keep = owes.id;
      } else if (open.length && !holds.length) {
        // A failed hold: its link ended at the deadline, so the session goes unpaid.
        out.never.push(index);
      } else {
        const attempt = record.attempt + 1;
        out.charge.push({ index, attempt, key: chargeKey(input.seriesId, index, attempt) });
      }
    } else if (!stays && !(late && paid.length)) out.never.push(index);
    for (const h of holds) if (h.id !== keep) out.close.push(closeStep(h.id, "release"));
    for (const i of open) if (i.id !== keep) out.close.push(closeStep(i.id, "cancel"));
  }
  return out;
}

/**
 * What the link to pay a failed hold or charge does, read again when it is
 * opened and when it is paid: nothing to pay without a PaymentIntent, or
 * once it is held or paid; refused once it is canceled; an owed charge (a
 * session that took place, or one the buyer stopped late) stays payable;
 * otherwise refused once the session is stopped, and from `payBy` on.
 */
export function payLink(input: { stopped: boolean; owed?: boolean; status: IntentStatus | null; now: number; payBy: number }): "pay" | "none" | "stopped" | "closed" | "late" | "done" {
  if (input.status === null) return "none";
  if (input.status === "canceled") return "closed";
  if (input.status === "succeeded" || input.status === "requires_capture" || input.status === "processing") return "done";
  if (input.owed) return "pay";
  if (input.stopped) return "stopped";
  if (input.now >= input.payBy) return "late";
  return "pay";
}

/**
 * What is refunded when one session is canceled on its own, by the buyer or
 * the creator, at `at`: toStop's refunds for that session alone, from the
 * PaymentIntents just listed (`found`), never from the record alone.
 */
export function sessionRefunded(record: ChargeRecord, found: readonly FoundIntent[], input: { seriesId: string; start: number; at: number; by: "creator" | "buyer"; deadlineHours: number }): Refund[] {
  const starts: number[] = [];
  starts[record.index] = input.start;
  return toStop([record.index], [record], { seriesId: input.seriesId, found, starts, at: input.at, by: input.by, deadlineHours: input.deadlineHours }).refund;
}

export type BillingProblem = "deposit" | "code" | "package";

/** Whether a series may be charged this way, or why not. */
export function seriesBillingProblem(input: { deposit: boolean; code: boolean; fromPackage: boolean }): BillingProblem | null {
  if (input.deposit) return "deposit";
  if (input.code) return "code";
  if (input.fromPackage) return "package";
  return null;
}

const same = (a: SeriesCharge, b: SeriesCharge) => a.index === b.index && a.cents === b.cents && a.at === b.at && a.captureAt === b.captureAt && a.way === b.way && a.refundFee === b.refundFee;

/**
 * What the buyer agrees to before booking, in US English, worked out from
 * the charges themselves: `charges` from seriesCharges, `starts` each
 * session's start, `dates` each session's day and time as said, and `money`
 * the store's currency formatter. Throws when the deadline is not one of
 * SERIES_DEADLINES, or when any charge is not the one sessionCharge plans
 * for that start, so the words never say other than what will be charged.
 */
export function seriesChargeWords(input: { charges: readonly SeriesCharge[]; starts: readonly number[]; dates: readonly string[]; money: (cents: number) => string; store: string; bookedAt: number; deadlineHours?: number }): string {
  const { charges, starts, dates, store } = input;
  const deadline = readDeadline(input.deadlineHours);
  if (deadline === null) throw new Error("series words: the deadline is not one a series may have");
  if (!charges.length || charges.length !== dates.length || charges.length !== starts.length) throw new Error("series words: the charges, the starts and the dates do not agree");
  if (charges.some((c, i) => !same(c, sessionCharge(i, starts[i], input.bookedAt, charges[0].cents, deadline)))) throw new Error("series words: a charge is not the one planned for its session");
  const total = input.money(charges.reduce((sum, c) => sum + c.cents, 0));
  const price = input.money(charges[0].cents);
  const first = charges[0];
  const when = deadline ? "a day before the cancellation deadline" : "a day before it starts";
  return [
    `You book ${charges.length} sessions for ${total} in all.`,
    `The dates: ${dates.join("; ")}.`,
    `Your card is saved with ${store}'s payment account and used without you there, as described here.`,
    `For each session, ${price} is reserved on your card ${when}.`,
    deadline ? `It is charged at the deadline, ${deadline} hours before the session starts.` : "It is charged when the session starts.",
    first.way === "hold"
      ? "For the first session, it is reserved now."
      : first.refundFee
        ? "The first session is charged now."
        : `The first session starts in less than ${deadline} hours, so it is charged now and not refunded if you cancel.`,
    "If your card cannot be reserved, we email you a link to pay.",
    deadline ? "Pay by the cancellation deadline, or that session is canceled and you are not charged." : "Pay before the session starts, or it is canceled and you are not charged.",
    ...(deadline
      ? ["If the charge at the deadline fails, the link works until the session starts.", "If it is not paid by then, that session is canceled and you are not charged."]
      : ["If the charge when it starts fails, we email you a link to pay it."]),
    deadline ? `Cancel a session at least ${deadline} hours before it starts and you pay nothing for it.` : "Cancel a session any time before it starts and you pay nothing for it.",
    "The reservation is released, and anything already charged is refunded.",
    ...(deadline ? ["If you cancel later or miss it, it is not refunded.", "If you cancel later and its charge failed, you still owe it."] : ["If you miss it, it is not refunded."]),
    `If ${store} cancels, you get back what was charged for every session that does not take place.`,
    "This does not affect your rights under the law.",
  ].join(" ");
}

/**
 * What the buyer and the creator are told about a failed payment, by the
 * step that failed (`hold`: the card could not be reserved; `charge`: it
 * could not be charged): when the link is sent (`pay_by_link`), when the
 * session is canceled unpaid (`cancel`: at the cancellation deadline after a
 * failed hold with a deadline, otherwise when it was due to start), and when
 * a session that took place stays owed (`owed`). `date` is the session's day
 * and time as said, `payBy` when the link stops working as said; the buyer
 * is not named.
 */
export function failedChargeWords(input: { to: "buyer" | "creator"; what: "pay_by_link" | "cancel" | "owed"; step: "hold" | "charge"; date: string; payBy: string; deadlineHours: number }): string {
  const { to, what, date, payBy: by } = input;
  const verb = input.step === "hold" ? "reserved" : "charged";
  const at = input.step === "hold" && input.deadlineHours > 0 ? "at the cancellation deadline" : "when it was due to start";
  if (what === "pay_by_link") {
    return to === "buyer"
      ? [`Your card could not be ${verb} for your session on ${date}.`, `Pay with the link below by ${by}.`, "If it is not paid by then, the session is canceled and you are not charged."].join(" ")
      : [`The buyer's card could not be ${verb} for the session on ${date}.`, `We emailed them a link to pay by ${by}.`, "If it is not paid by then, the session is canceled and its time opens again."].join(" ");
  }
  if (what === "owed") {
    return to === "buyer"
      ? [`Your card could not be charged for your session on ${date}.`, "Please pay what you owe with the link below."].join(" ")
      : [`The buyer's card could not be charged for the session on ${date}.`, "We emailed them a link to pay what they owe."].join(" ");
  }
  return to === "buyer"
    ? [`Your session on ${date} was canceled ${at}, because it was not paid.`, "You were not charged for it."].join(" ")
    : [`The session on ${date} was canceled ${at}, because it was not paid.`, "Nothing was charged, and its time is open again."].join(" ");
}
