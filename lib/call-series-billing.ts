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
 *     moved inside its deadline by the buyer, it is charged at once and not
 *     refunded to a buyer canceling, as for a first session booked inside
 *     it. Moved inside its deadline by the creator (owner, C2-62, 4 November
 *     2026), it is only held at once and captured at its start; the buyer
 *     canceling before the start has the hold released, nothing charged, so
 *     a creator's move never makes a session kept before it starts. Its
 *     cancelBy (SeriesCharge) is then its start, and the change message says
 *     so (moveCase, lib/buyer-words/series-move.ts).
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
 *   - Match the listed PaymentIntents by their prefixed metadata
 *     (seriesMetadata: mm_series, mm_session, mm_attempt), amount, currency
 *     and the platform's application (SeriesKey); write mm_attempt on every
 *     one created, and store the attempt with the PaymentIntent.
 *   - While the latest attempt's PaymentIntent is unknown, send it again
 *     under the same key with the same body (chargeAttempt "repeat"):
 *     Stripe answers with the same PaymentIntent, or 409 while the first
 *     request is in flight (wait, list again, decide again). Raise the
 *     attempt only once that PaymentIntent is known canceled or failed.
 *   - After every success (a create, capture or charge answered, and every
 *     payment_intent.succeeded or amount_capturable_updated webhook), list
 *     again and decide again: chargeAttempt for a session that stands,
 *     toStop or paidAfterStop for a stopped one, so a duplicate of a
 *     session that stands is refunded too, and never twice paid.
 *   - On every move, set `kept` with keptOnMove from the charge worked
 *     out for the new start, before anything else, so a paid session the
 *     buyer moved inside its deadline stays kept whatever moves it later.
 *   - Start each attempt with startAttempt (its parameters on the
 *     allow-list, attemptKeyRefused and attemptFailed back to false); read
 *     a create's error with createErrorStep and a refund's with
 *     refundOutcome.
 *   - Send a refund without an amount (what is left is refunded). A
 *     capture, cancel or refund Stripe answers with an error has it cached
 *     on its key for 24 hours, so every try goes under its own key
 *     (tryKey). Store a refund refused for good in ChargeRecord.refused and
 *     report it to the creator; a disputed charge is never refunded.
 *   - Take every decision under the series' lock, after reading the
 *     session again: a stopped one takes only what toStop says.
 *
 * The next unit's checklist (round-8 review, 4 November 2026):
 *   - Store per session its SeriesCharge, movedBy and the moment it was
 *     worked out, and pass 0 hours to failedCharge, payBy and the words for
 *     a session the creator moved inside its deadline (its cancelBy is its
 *     start).
 *   - Decide under the series' lock with `at` the moment a cancellation is
 *     accepted there, never a time the request carries; a charge counts as
 *     kept for a stop only when it was made before that moment.
 *   - List every page (has_more) with expand[]=data.latest_charge, and read
 *     each hold's capture_before from it.
 *   - Schedule each step: holds at charge.at, captures at captureMoment,
 *     non-payment cancels at payBy, retries after listing again.
 *   - startAttempt before every create; store the PaymentIntent, its
 *     attempt, heldAt and capture_before on every reply; set attemptFailed
 *     on a definitive refusal that made no PaymentIntent, then follow
 *     failedCharge and create the unconfirmed PaymentIntent for the pay
 *     link (chargeAttempt "link").
 *   - Count every capture, cancel and refund in ChargeRecord.tries and send
 *     the next try under tryKey; record a refund refused for good and tell
 *     the creator.
 *   - Check, against Stripe's and the card networks' dated official rules,
 *     the wording the buyer agrees to for merchant-initiated charges on a
 *     saved card, and the create parameters on ATTEMPT_BODY_KEYS.
 *   - Send every email of these rules in the seven store languages.
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
/** How long Stripe is sure to keep an idempotency key (docs.stripe.com/api/idempotent_requests: removed "after they're at least 24 hours old"). */
export const KEY_KEPT_HOURS = 24;
const HOUR = 3_600_000;

/** Who moved a session to its current start: the buyer within the rules, the creator, or nobody (as booked). */
export type MovedBy = "creator" | "buyer" | null;

export type SeriesCharge = {
  index: number;
  cents: number;
  /** When the hold is placed, or the amount charged at once when `way` is "charge". */
  at: number;
  /** When it is captured: the deadline before the session, or its start for a session the creator moved inside its deadline. The same as `at` when `way` is "charge". */
  captureAt: number;
  way: "hold" | "charge";
  /** Charged before the buyer's last moment to cancel for free: a refund in time loses Stripe's fee. The margin table reads it. */
  refundFee: boolean;
  /** Who moved the session to the start this charge was worked out from. */
  movedBy: MovedBy;
  /**
   * The buyer's last moment to cancel for free and to pay a failed hold:
   * the deadline, or the session's start when the creator moved it inside
   * its deadline. A charge made from it on is kept (keptOnCharge).
   */
  cancelBy: number;
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
 * returns it; `movedBy` who moved it there (null as booked).
 *
 * Moved inside its deadline by the buyer: charged at once and kept. Moved
 * inside it by the creator (owner's decision C2-62, 4 November 2026): only
 * held at once and captured at the session's start, so the buyer can still
 * cancel for free until it starts (cancelBy) and a creator's move never
 * makes a session kept before it starts. A hold that would not last until
 * the start is placed again inside its window (captureTime), never
 * captured before the start.
 */
export function sessionCharge(index: number, start: number, bookedAt: number, cents: number, deadlineHours: number, now = bookedAt, movedBy: MovedBy = null): SeriesCharge {
  const from = Math.max(bookedAt, now);
  const deadline = deadlineOf(start, deadlineHours);
  const captureAt = Math.max(from, deadline);
  // The first, at booking, is held with the buyer there; any other (or a first moved later), a day before its deadline.
  const at = index === 0 && from === bookedAt ? bookedAt : Math.max(from, captureAt - HOLD_LEAD_HOURS * HOUR);
  if (captureAt === at) {
    // Inside the deadline by the creator's move: held now, captured at the start, free to cancel until then.
    if (movedBy === "creator" && start > from) return { index, cents, at, captureAt: start, way: "hold", refundFee: false, movedBy, cancelBy: start };
    // The deadline already passed (at booking, or by the buyer's move inside it): charged at once, and never refunded to a buyer canceling.
    return { index, cents, at, captureAt: at, way: "charge", refundFee: false, movedBy, cancelBy: deadline };
  }
  // A hold would not last until the deadline (only a first session far from its booking): charged at once, refunded if canceled in time.
  if (captureAt - at > HOLD_MAX_HOURS * HOUR) return { index, cents, at, captureAt: at, way: "charge", refundFee: true, movedBy, cancelBy: deadline };
  return { index, cents, at, captureAt, way: "hold", refundFee: false, movedBy, cancelBy: deadline };
}

/**
 * When each session is held and captured, and how much. Null when the
 * amount is not a whole positive number of the currency's smallest unit at
 * or above `least` (the currency's smallest charge, lib/money.ts), the
 * deadline is not one of SERIES_DEADLINES, or a session starts at or before
 * the booking.
 */
export function seriesCharges(starts: readonly number[], cents: number, bookedAt: number, least: number, deadlineHours?: number): SeriesCharge[] | null {
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents < least) return null;
  const deadline = readDeadline(deadlineHours);
  if (deadline === null) return null;
  if (!starts.every((start) => Number.isFinite(start) && start > bookedAt)) return null;
  return starts.map((start, index) => sessionCharge(index, start, bookedAt, cents, deadline));
}

/** When a hold stops being safe to capture: Stripe's capture_before, or the shortest listed window from the hold's own time when Stripe did not say, less the margin. */
export function holdGoodUntil(heldAt: number, captureBefore: number | null): number {
  return (captureBefore ?? heldAt + AUTH_WINDOW_HOURS * HOUR) - CAPTURE_MARGIN_HOURS * HOUR;
}

/** When a session is captured, worked out at `now`: CAPTURE_DELAY_MS after its capture time (or at once, once that has passed); a session charged at once, at once. */
export function captureMoment(charge: SeriesCharge, now: number): number {
  return charge.way === "hold" ? Math.max(charge.captureAt + CAPTURE_DELAY_MS, now) : Math.max(charge.at, now);
}

/**
 * What to do with a session's hold at `now`: capture it at captureMoment
 * while it is still good then. Otherwise, before the capture time, release
 * it and place a new one at the planned time (or now); from the capture
 * time on, or for a session now charged at once (moved inside its deadline
 * by the buyer), charge at once instead. Never a capture at or after the
 * hold's expiry, and never earlier than the capture time (the deadline, or
 * the start for a session the creator moved inside its deadline).
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
 * place and what is owed stays on the link, never canceled). A session the
 * creator moved inside its deadline is read with 0 (its start).
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
 * creation and `captureBefore` that charge's, when known; `attempt` the
 * attempt it was created under (its metadata mm_attempt).
 */
export type Intent = { id: string; status: IntentStatus; capture: "manual" | "automatic"; created: number; heldAt: number | null; captureBefore: number | null; attempt: number | null };

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
  /** When the latest attempt was started. */
  attemptAt: number | null;
  /**
   * The exact parameters the latest attempt's create was sent with, as sent
   * (amount, currency, customer, payment_method, capture_method, confirm,
   * off_session, setup_future_usage, mandate, the metadata): a retry of it
   * sends exactly these under the same key, never parameters rebuilt.
   */
  attemptBody: Readonly<Record<string, string>> | null;
  /** Stripe answered the latest attempt's key with an idempotency_error (other parameters): that key was used, so the list decides, never a wait on the key. Back to false with each new attempt (startAttempt); an idempotency_key_in_use (409) is a wait, never this (createErrorStep). */
  attemptKeyRefused: boolean;
  /** Stripe refused the latest attempt's create for good without making a PaymentIntent (a request error, a card removed): it is not unknown, failedCharge decides, and the pay link gets an unconfirmed PaymentIntent (chargeAttempt "link"). Back to false with each new attempt. */
  attemptFailed: boolean;
  /** The latest one, stored as soon as Stripe answers, with the attempt it belongs to; null until then. */
  intent: Intent | null;
  /** Its charge was refunded in full already. */
  refunded: boolean;
  /** Its charge was made from its cancelBy on (keptOnCharge): never refunded to the buyer. */
  kept: boolean;
  /**
   * PaymentIntents whose refund Stripe refused for good (the charge
   * disputed, or a request error no retry changes): never sent again,
   * reported. A passing error (a 5xx, the network, a rate limit) is not one:
   * it is counted in tries, and the next try, after listing again, goes
   * under a new key (a refund without an amount returns what is left).
   */
  refused: readonly string[];
  /** How many calls were sent for each step on each PaymentIntent, by "step:id" ("capture:pi_…", "cancel:pi_…", "refund:pi_…"): the next one goes under the next key. */
  tries: Readonly<Record<string, number>>;
};

/**
 * The series as the PaymentIntents name it: its id, the platform's Connect
 * application they are created by (its ca_ id, as a PaymentIntent's
 * `application` reads, never an acct_ account id), and the store's currency.
 */
export type SeriesKey = { id: string; application: string; currency: string };

/** The metadata every PaymentIntent of a series is created with, prefixed so no other metadata is ever read as it. */
export function seriesMetadata(seriesId: string, index: number, attempt: number): Record<string, string> {
  return { mm_series: seriesId, mm_session: String(index), mm_attempt: String(attempt) };
}

/**
 * The only parameters an attempt's create may carry (the metadata only
 * under mm_): nothing personal is stored with the attempt (no mandate_data
 * with an IP address or user agent), and what is stored is exactly what is
 * sent again.
 */
export const ATTEMPT_BODY_KEYS = [
  "amount",
  "currency",
  "customer",
  "payment_method",
  "capture_method",
  "confirm",
  "off_session",
  "setup_future_usage",
  "mandate",
  "description",
  "statement_descriptor_suffix",
  "return_url",
  "automatic_payment_methods[enabled]",
  "automatic_payment_methods[allow_redirects]",
] as const;

/**
 * The record as a new attempt starts, written under the lock before its
 * create is sent: the next attempt, its time, exactly the parameters it is
 * sent with, and attemptKeyRefused and attemptFailed back to false (they
 * belong to the attempt). Throws on a parameter outside ATTEMPT_BODY_KEYS,
 * payment_method_types[] or metadata[mm_*]. The list is the parameters an
 * off-session charge on a saved card needs as read from Stripe's API
 * reference for PaymentIntents (create); not yet checked against its dated
 * page in this unit: to verify against the dated docs before the first
 * real charge.
 */
export function startAttempt(record: ChargeRecord, now: number, body: Readonly<Record<string, string>>): ChargeRecord {
  for (const key of Object.keys(body)) {
    if (!(ATTEMPT_BODY_KEYS as readonly string[]).includes(key) && !/^metadata\[mm_[a-z_]+\]$/.test(key) && !/^payment_method_types\[\d*\]$/.test(key)) throw new Error(`startAttempt: ${key} is not a parameter an attempt may carry`);
  }
  return { ...record, attempt: record.attempt + 1, attemptAt: now, attemptBody: { ...body }, attemptKeyRefused: false, attemptFailed: false };
}

/**
 * What a create that Stripe answered with an error comes to:
 * idempotency_key_in_use (409, the first request still in flight): wait,
 * list again and decide again; idempotency_error (the key was used with
 * other parameters): it was processed, so set attemptKeyRefused and let
 * the list decide; anything else: the attempt failed (set attemptFailed
 * when Stripe made no PaymentIntent, then failedCharge decides).
 */
export function createErrorStep(code: string | undefined): "wait" | "decide_from_list" | "failed" {
  if (code === "idempotency_key_in_use") return "wait";
  if (code === "idempotency_error") return "decide_from_list";
  return "failed";
}

/**
 * What a refund call's answer comes to: no error, or charge_already_refunded
 * (what was left is already back): done; a disputed charge, or another
 * request error no retry changes (a 4xx other than 409 and 429): refused
 * for good (ChargeRecord.refused); a 5xx, 409, 429, a lock timeout or no
 * answer at all: tried again under the next refundKey after listing again.
 */
export function refundOutcome(error: { code?: string; status?: number } | null): "done" | "refused" | "retry" {
  if (!error || error.code === "charge_already_refunded") return "done";
  if (error.code === "charge_disputed") return "refused";
  if (error.code === "lock_timeout" || error.code === "rate_limit") return "retry";
  const status = error.status ?? 0;
  if (status >= 400 && status < 500 && status !== 409 && status !== 429) return "refused";
  return "retry";
}

/** The key one attempt is created under on the creator's Stripe account. Kept by Stripe for about 24 hours only: a later retry relies on chargeAttempt. */
export function chargeKey(seriesId: string, index: number, attempt: number): string {
  return `series:${seriesId}:${index}:${attempt}`;
}

/**
 * The key a step on an existing PaymentIntent is sent under: one per
 * PaymentIntent and step, so no key is ever sent again for another
 * PaymentIntent's refund, capture or cancel. Releasing a hold and canceling
 * an open one are the same call with the same body (no
 * cancellation_reason), so they share the cancel key. A refund is sent
 * without an amount (what is left is refunded), under refundKey.
 */
export function stepKey(step: "capture" | "cancel" | "refund", id: string, tryNumber?: number): string {
  return tryNumber === undefined ? `series:${step}:${id}` : `series:${step}:${id}:${tryNumber}`;
}

/** The key the next call of a step on a PaymentIntent goes under: one per try, so a passing error cached on one key never blocks the next try. */
export function tryKey(record: ChargeRecord, step: "capture" | "cancel" | "refund", id: string): string {
  return stepKey(step, id, (record.tries[`${step}:${id}`] ?? 0) + 1);
}

/** The key the next refund of a PaymentIntent goes under (tryKey). */
export function refundKey(record: ChargeRecord, id: string): string {
  return tryKey(record, "refund", id);
}

/**
 * Whether a capture or charge that succeeded at `chargedAt` leaves the
 * session's charge kept: made from the charge's cancelBy on (the deadline,
 * or the start for a session the creator moved inside its deadline). Never
 * clears `kept`: a charge kept before the session was moved stays kept
 * after it, whoever moved it, and the creator canceling still refunds it.
 */
export function keptOnCharge(record: ChargeRecord, chargedAt: number, charge: SeriesCharge): boolean {
  return record.kept || chargedAt >= charge.cancelBy;
}

/**
 * Whether a session's charge is kept after a move, worked out from the
 * charge for its new start and the PaymentIntents just listed: kept
 * already, or paid (not refunded in full) and moved
 * to where its cancelBy has passed (the buyer moving a paid session inside
 * its deadline: a late cancellation is paid). Never clears `kept`, so a
 * later move by the creator does not make it refundable again.
 */
export function keptOnMove(series: SeriesKey, record: ChargeRecord, found: readonly FoundIntent[], charge: SeriesCharge): boolean {
  return record.kept || (sessionIntents(series, record, found).some((i) => i.status === "succeeded" && !i.full) && charge.cancelBy <= charge.at);
}

/**
 * A PaymentIntent as listed on the connected account (with
 * expand[]=data.latest_charge): `amount`, `currency` and `application` as
 * Stripe lists them; `amountReceived` and `amountRefunded` its latest
 * charge's amounts (amount_received, amount_refunded), and `disputed` that
 * charge's dispute flag.
 */
export type FoundIntent = Intent & {
  metadata: Record<string, string | undefined>;
  amount: number;
  currency: string;
  application?: string | null;
  amountReceived: number;
  amountRefunded: number;
  disputed: boolean;
};

/**
 * A session's PaymentIntent as decided on, the record's and the list's
 * merged: `full` when what was received was refunded in full, `left` what
 * is still refundable, `disputed` when its charge is disputed (Stripe
 * refuses a refund then).
 */
export type Live = Intent & { full: boolean; left: number; disputed: boolean; mismatch: boolean };

const RANK: IntentStatus[] = ["succeeded", "requires_capture", "processing", "requires_action", "requires_confirmation", "requires_payment_method"];

/**
 * Whether a listed PaymentIntent is this session's: its prefixed metadata
 * names this series and session. One that does, but with another amount,
 * currency or application (null included; not checked only when Stripe's
 * object does not carry it), is a mismatch: never ignored, never acted on,
 * reported, and it blocks any new charge for the session.
 */
function matchOf(series: SeriesKey, record: ChargeRecord, f: FoundIntent): "mine" | "mismatch" | "other" {
  if (f.metadata.mm_series !== series.id || f.metadata.mm_session !== String(record.index)) return "other";
  if (f.amount !== record.cents || f.currency.toLowerCase() !== series.currency.toLowerCase()) return "mismatch";
  return f.application !== undefined && f.application !== series.application ? "mismatch" : "mine";
}

/** The record's PaymentIntent merged with those listed as this session's, canceled ones included. */
function allIntents(series: SeriesKey, record: ChargeRecord, found: readonly FoundIntent[]): Live[] {
  const mine = new Map<string, Live>();
  if (record.intent) {
    const paid = record.intent.status === "succeeded";
    mine.set(record.intent.id, { ...record.intent, full: paid && record.refunded, left: paid && !record.refunded ? record.cents : 0, disputed: false, mismatch: false });
  }
  for (const f of found) {
    const match = matchOf(series, record, f);
    if (match === "other") continue;
    const stored = mine.get(f.id);
    const attempt = Number(f.metadata.mm_attempt);
    mine.set(f.id, {
      id: f.id,
      status: f.status,
      capture: f.capture,
      created: f.created,
      heldAt: f.heldAt ?? stored?.heldAt ?? null,
      captureBefore: f.captureBefore ?? stored?.captureBefore ?? null,
      attempt: Number.isSafeInteger(attempt) && attempt > 0 ? attempt : (stored?.attempt ?? null),
      full: f.amountReceived > 0 && f.amountRefunded >= f.amountReceived,
      left: Math.max(0, f.amountReceived - f.amountRefunded),
      disputed: f.disputed,
      mismatch: match === "mismatch",
    });
  }
  return [...mine.values()];
}

/**
 * A session's PaymentIntents that are not canceled: every one not refunded
 * in full before any refunded in full, then furthest along first. The
 * record's merged with those listed for this series and session (by their
 * prefixed metadata, amount, currency and application; a mismatch is left
 * out here and reported by blockers). The listed status
 * wins; a hold time or capture_before the list did not carry is kept from
 * the record.
 */
export function sessionIntents(series: SeriesKey, record: ChargeRecord, found: readonly FoundIntent[]): Live[] {
  return allIntents(series, record, found)
    .filter((i) => i.status !== "canceled" && !i.mismatch)
    .sort((a, b) => Number(a.full) - Number(b.full) || RANK.indexOf(a.status) - RANK.indexOf(b.status));
}

/**
 * Whether the session's latest attempt is still unknown at `now`: started,
 * no PaymentIntent of it stored or listed, and its key still kept by
 * Stripe. Then the request may still be in flight (or have died before it
 * reached Stripe): it is sent again under the same key with the same body,
 * and Stripe answers with its PaymentIntent (409 while it is in flight:
 * wait and decide again), never a second one. An idempotency_error (the key
 * was used with other parameters) means it was processed: the list decides
 * (attemptKeyRefused), never a 24-hour wait.
 */

/**
 * Why no new PaymentIntent may be made for a session, read on the list: a
 * PaymentIntent with this session's metadata but another amount, currency
 * or application (`mismatch`); its only payment refunded in full outside
 * these rules, by the creator in their Stripe dashboard (`refunded`: the
 * buyer is never charged again without an explicit decision); or a
 * SeriesKey whose application is not a ca_ id (`config`). Each is reported
 * to the creator. Blockers are read before anything else: while one stands,
 * nothing is reused, captured or created for the session; a late stop's
 * good hold is postponed (neither captured nor released), while toStop
 * still releases holds and cancels open PaymentIntents of the session that
 * are not the mismatch and refunds its own payments as its rules say,
 * since none of that charges the buyer. At its deadline and at its start such a
 * session stands as booked: nothing is charged and it is not canceled for
 * non-payment; the creator decides (refund, cancel, or charge again
 * explicitly) and the buyer is told the payment is being checked.
 */
export type Blocked = { why: "mismatch" | "refunded" | "config"; ids: string[] };

function blockers(series: SeriesKey, record: ChargeRecord, all: readonly Live[]): Blocked | null {
  if (!series.application.startsWith("ca_")) return { why: "config", ids: [] };
  // A mismatch refunded in full or canceled can charge nothing more: it stops blocking.
  const mismatch = all.filter((i) => i.mismatch && i.status !== "canceled" && !(i.status === "succeeded" && i.full));
  if (mismatch.length) return { why: "mismatch", ids: mismatch.map((i) => i.id) };
  return null;
}
function unknownAttempt(record: ChargeRecord, all: readonly Live[], now: number): boolean {
  if (record.attempt === 0 || record.attemptAt === null || record.attemptBody === null || record.attemptKeyRefused || record.attemptFailed) return false;
  if (record.intent?.attempt === record.attempt || all.some((i) => i.attempt === record.attempt)) return false;
  return now - record.attemptAt < KEY_KEPT_HOURS * HOUR;
}

/**
 * A PaymentIntent closed, with the key its call is sent under: a payment
 * refunded (what is left of it), a hold released or an open one canceled
 * (both a cancel on Stripe). `wait`: one processing, which Stripe neither
 * refunds nor cancels: left, reported, and decided again once it has
 * settled (refunded if it succeeds). `report`: a payment that cannot be
 * refunded (disputed, or a refund Stripe refused already): told to the
 * creator, never sent again. Neither makes a call or has a key.
 */
export type Close = { id: string; action: "refund_in_full" | "release" | "cancel" | "wait" | "report"; key: string | null };

function closeStep(id: string, action: Close["action"], record: ChargeRecord): Close {
  if (action === "wait" || action === "report") return { id, action, key: null };
  return { id, action, key: tryKey(record, action === "refund_in_full" ? "refund" : "cancel", id) };
}

/** How an unwanted PaymentIntent is closed: a payment refunded unless it cannot be, a hold released (or captured when `paid`), one processing waited on. */
function closeOf(i: Live, record: ChargeRecord, stale: boolean): Close | null {
  if (stale) return closeStep(i.id, "release", record);
  const action = paidAfterStop(i.status, false, i.full);
  if (action === "none" || action === "capture") return null;
  if (action === "refund_in_full" && (i.disputed || record.refused.includes(i.id))) return closeStep(i.id, "report", record);
  return closeStep(i.id, action, record);
}

/**
 * Whether to reuse a PaymentIntent for a session, send its latest attempt
 * again, create one, wait, or do nothing, at `now`: `found` is the buyer's
 * PaymentIntents listed on the creator's account, every page (the list API,
 * never search).
 *   - A stopped session never gets a new one.
 *   - While the latest attempt is unknown (unknownAttempt), it is sent again
 *     (`repeat`): the same key and exactly the parameters stored with it
 *     (attemptBody); nothing else is decided until its PaymentIntent is
 *     known.
 *   - `report`, never a new PaymentIntent, when blockers say so, or when
 *     its only payment was refunded in full outside these rules.
 *   - A hold that would not be good at its capture moment is released,
 *     never reused; a payment refunded in full is never reused.
 *   - A good hold beside one processing is not captured while it stays
 *     good (`wait`, until it would turn stale): whichever settles decides,
 *     never both paid.
 *   - Any other one is reused, the furthest along first, and the rest
 *     closed (one processing is waited on, never counted paid).
 *   - A failed one (waiting on the buyer) from an earlier plan: before the
 *     session's planned time it is canceled and the session waits for that
 *     time (moved later); a failed hold for a session now charged at once
 *     (the buyer moved it inside its deadline) is canceled and the session
 *     charged now, off-session; otherwise it is reused, for its pay link.
 *   - After a create refused for good with no PaymentIntent
 *     (attemptFailed): `link`, one unconfirmed PaymentIntent for the pay
 *     link, never the same request again.
 *   - With none left, nothing new before the session's planned time
 *     (`wait`, at that time, never earlier); from it, one is created under
 *     the next attempt's key, only once the latest attempt's PaymentIntent
 *     is known canceled or failed: a hold before the capture time, a charge
 *     at once from it on.
 */
export function chargeAttempt(
  series: SeriesKey,
  record: ChargeRecord,
  found: readonly FoundIntent[],
  input: { charge: SeriesCharge; stopped: boolean; now: number },
):
  | { do: "stop" }
  | { do: "repeat"; attempt: number; key: string; body: Readonly<Record<string, string>> }
  | { do: "report"; why: Blocked["why"]; ids: string[] }
  | { do: "reuse"; id: string; close: Close[] }
  | { do: "wait"; at: number; close: Close[] }
  | { do: "create"; attempt: number; key: string; capture: "manual" | "automatic"; close: Close[] }
  | { do: "link"; attempt: number; key: string; capture: "manual" | "automatic"; close: Close[] } {
  if (input.stopped) return { do: "stop" };
  const all = allIntents(series, record, found);
  if (unknownAttempt(record, all, input.now)) return { do: "repeat", attempt: record.attempt, key: chargeKey(series.id, record.index, record.attempt), body: record.attemptBody as Readonly<Record<string, string>> };
  const blocked = blockers(series, record, all);
  if (blocked) return { do: "report", why: blocked.why, ids: blocked.ids };
  const live = sessionIntents(series, record, found);
  const moment = captureMoment(input.charge, input.now);
  const stale = (i: Intent) => i.status === "requires_capture" && holdGoodUntil(holdTime(i), i.captureBefore) < moment;
  const usable = live.filter((i) => !i.full && !stale(i));
  const close = (keep: readonly string[]) => live.flatMap((i) => (keep.includes(i.id) ? [] : [closeOf(i, record, stale(i))].filter((c): c is Close => c !== null)));
  const best = usable[0];
  const processing = usable.find((i) => i.status === "processing");
  if (best?.status === "requires_capture" && processing) {
    // Never capture beside a payment still processing: wait while the hold stays good; then it is released and the other decides.
    return { do: "wait", at: Math.max(input.charge.at, holdGoodUntil(holdTime(best), best.captureBefore) + 1), close: close([best.id, processing.id]) };
  }
  // A payment refunded in full outside these rules: never a pay link or a new charge for it; a payment, a hold or one processing still decides.
  const refundedOutside = live.filter((i) => i.status === "succeeded" && i.full);
  const open = best && best.status !== "succeeded" && best.status !== "requires_capture" && best.status !== "processing";
  if (refundedOutside.length && (!best || open)) return { do: "report", why: "refunded", ids: refundedOutside.map((i) => i.id) };
  const attempt = record.attempt + 1;
  const capture = input.charge.way === "hold" && input.now < input.charge.captureAt ? "manual" : "automatic";
  if (best && open) {
    // A failed one from an earlier plan (the session moved later): canceled, and the session planned again at its time.
    if (input.now < input.charge.at) return { do: "wait", at: input.charge.at, close: close([]) };
    // A failed hold and the session now charged at once (the buyer moved it inside its deadline): canceled, and charged now.
    if (input.charge.way === "charge" && best.capture === "manual") return { do: "create", attempt, key: chargeKey(series.id, record.index, attempt), capture: "automatic", close: close([]) };
  }
  if (best) return { do: "reuse", id: best.id, close: close([best.id]) };
  if (input.now < input.charge.at) return { do: "wait", at: input.charge.at, close: close([]) };
  // Refused for good with no PaymentIntent made: one unconfirmed, for the pay link (failedCharge).
  if (record.attemptFailed) return { do: "link", attempt, key: chargeKey(series.id, record.index, attempt), capture, close: close([]) };
  return { do: "create", attempt, key: chargeKey(series.id, record.index, attempt), capture, close: close([]) };
}

/**
 * Whether a session is canceled for non-payment (at the deadline, or at its
 * start after a failed charge), decided on the PaymentIntents just listed,
 * never on the record alone: a link paid a moment ago (held, processing or
 * paid and not refunded) keeps the session; an attempt still unknown at
 * `now` (in flight) waits; a blocker is reported, never canceled as
 * unpaid; otherwise it is canceled and its open
 * PaymentIntents canceled, each under its own key.
 */
export function unpaidCancel(series: SeriesKey, record: ChargeRecord, found: readonly FoundIntent[], now: number): { do: "keep" } | { do: "wait" } | { do: "report"; why: Blocked["why"]; ids: string[] } | { do: "cancel"; close: Close[] } {
  const all = allIntents(series, record, found);
  if (unknownAttempt(record, all, now)) return { do: "wait" };
  // A mismatch may be a payment: never "you were not charged"; reported, the creator decides.
  const blocked = blockers(series, record, all);
  if (blocked) return { do: "report", why: blocked.why, ids: blocked.ids };
  const live = sessionIntents(series, record, found);
  if (live.some((i) => (i.status === "succeeded" && !i.full) || i.status === "requires_capture" || i.status === "processing")) return { do: "keep" };
  // Paid and refunded in full outside these rules: the creator decides; never "you were not charged".
  const refundedOutside = live.filter((i) => i.status === "succeeded" && i.full);
  if (refundedOutside.length) return { do: "report", why: "refunded", ids: refundedOutside.map((i) => i.id) };
  return { do: "cancel", close: live.filter((i) => i.status !== "succeeded").map((i) => closeStep(i.id, "cancel", record)) };
}

export type AfterStop = "refund_in_full" | "release" | "capture" | "cancel" | "wait" | "none";

/**
 * What is done with a session's PaymentIntent once the session is stopped,
 * including a payment that comes in after. `paid` is true when the buyer
 * stopped it after its cancelBy: then what was paid is kept and a hold is
 * captured, as a late cancellation is paid. As Stripe allows: only a payment
 * that succeeded is refunded, and never one refunded in full already
 * (`refunded`); a hold is released (canceled), never refunded; one
 * processing is waited on.
 */
export function paidAfterStop(status: IntentStatus, paid = false, refunded = false): AfterStop {
  if (status === "canceled") return "none";
  if (status === "succeeded") return paid || refunded ? "none" : "refund_in_full";
  if (status === "requires_capture") return paid ? "capture" : "release";
  if (status === "processing") return "wait";
  // Still open (unpaid or awaiting the buyer): canceled. If it still succeeds, the rule above decides.
  return "cancel";
}

/** A payment refunded when sessions are stopped, under its own key: sent without an amount, so what is left of it (`cents`) is refunded. */
export type Refund = { id: string; index: number; key: string; cents: number };

/**
 * Whether a paid PaymentIntent is kept from the buyer: the record's `kept`
 * for the one stored; for one never stored (found only on the list), a
 * captured hold always (a hold is captured only from its cancelBy on), a
 * charge at once when it was made from the cancelBy on. Only a charge made
 * before `at` (the moment the cancellation was accepted under the series'
 * lock) counts: one made after it never keeps a stop accepted in time.
 */
function keptCharge(i: Live, record: ChargeRecord, cancelBy: number, at: number): boolean {
  if (holdTime(i) >= at) return false;
  if (record.intent?.id === i.id) return record.kept;
  return i.capture === "manual" || holdTime(i) >= cancelBy;
}

export type StopSteps = {
  never: number[];
  close: Close[];
  refund: Refund[];
  capture: { id: string; key: string }[];
  charge: { index: number; attempt: number; key: string; capture: "manual" | "automatic"; body: Readonly<Record<string, string>> | null }[];
  owed: string[];
  pending: { id: string; index: number }[];
  postpone: { id: string; index: number; until: number }[];
  unrefundable: { id: string; index: number; why: "disputed" | "refused" }[];
  blocked: ({ index: number } & Blocked)[];
};

/**
 * What stopping canceled sessions at `at` does, decided on the
 * PaymentIntents just listed for the series (`found`, every page, matched
 * by metadata, amount, currency and application) merged with the records,
 * `at` is the moment the cancellation was accepted under the series' lock,
 * so a PaymentIntent whose id was never stored, or a second one made for
 * the same session, is dealt with too. Each call carries its key.
 * `cancelBy` is each session's own (SeriesCharge.cancelBy), required for
 * every session stopped (a session the creator moved inside its deadline
 * is free to cancel until its start); `cents` the price of a session with
 * no record. A session at its start has started: for one whose cancelBy is
 * its start, the last moment to cancel for free is just before it.
 *   - `blocked`: a mismatch (blockers) is reported, never acted on, and
 *     no new charge is made for its session; nor for a late stop whose only
 *     payment was refunded in full outside these rules.
 *   - `refund`: every payment for a stopped session that succeeded and is
 *     not refunded in full, except the one the buyer keeps paying for (a
 *     late stop by the buyer, or a kept charge); a duplicate always. What
 *     is left of a partly refunded one is refunded.
 *   - `unrefundable`: a payment to refund that is disputed, or whose refund
 *     Stripe refused already: reported to the creator, never sent again.
 *   - `close`: holds released and open PaymentIntents canceled.
 *   - `pending`: those processing, which Stripe can neither refund nor
 *     cancel: never counted paid, reported, and decided again once they
 *     have settled.
 *   - `never`: each session that must never be charged.
 *   - For sessions the buyer stopped after their cancelBy (a late
 *     cancellation is paid), when nothing was paid: a hold still good is
 *     captured (`capture`), or, beside one processing, left uncaptured while
 *     it stays good (`postpone`, decided again when either settles or by
 *     `until`); or nothing new while one is processing; or `owed`, a failed
 *     late charge left on its pay link; or, for a failed hold whose link
 *     ended at the deadline, nothing (the session goes unpaid); else
 *     `charge`, charged at once (no hold placed, or one canceled or
 *     expired): the latest attempt sent again, same key and body, while it
 *     is unknown, otherwise the next attempt.
 * A session already started at `at` took place and is not stopped here.
 */
export function toStop(
  canceled: readonly number[],
  records: readonly ChargeRecord[],
  input: { series: SeriesKey; found: readonly FoundIntent[]; starts: readonly number[]; at: number; by: "creator" | "buyer"; deadlineHours: number; cents: number; cancelBy: readonly number[] },
): StopSteps {
  const byIndex = new Map(records.map((r) => [r.index, r]));
  const out: StopSteps = { never: [], close: [], refund: [], capture: [], charge: [], owed: [], pending: [], postpone: [], unrefundable: [], blocked: [] };
  for (const index of canceled) {
    const start = input.starts[index];
    if (!(start > input.at)) continue;
    const record = byIndex.get(index) ?? { index, cents: input.cents, attempt: 0, attemptAt: null, attemptBody: null, attemptKeyRefused: false, attemptFailed: false, intent: null, refunded: false, kept: false, refused: [], tries: {} };
    const cancelBy = input.cancelBy[index];
    if (!Number.isFinite(cancelBy)) throw new Error(`toStop: no cancelBy for session ${index}`);
    const all = allIntents(input.series, record, input.found);
    const blocked = blockers(input.series, record, all);
    if (blocked) out.blocked.push({ index, ...blocked });
    const live = sessionIntents(input.series, record, input.found);
    // After the cancelBy, by the buyer: paid. At the cancelBy itself, in time.
    const late = input.by === "buyer" && input.at > cancelBy;
    const paid = live.filter((i) => i.status === "succeeded" && !i.full);
    // The one payment the buyer keeps paying for: after a late stop, or a kept charge; never when the creator stopped it.
    const stays = input.by === "buyer" ? paid.find((i) => late || keptCharge(i, record, cancelBy, input.at)) : undefined;
    for (const i of paid) {
      if (i.id === stays?.id) continue;
      if (i.disputed) out.unrefundable.push({ id: i.id, index, why: "disputed" });
      else if (record.refused.includes(i.id)) out.unrefundable.push({ id: i.id, index, why: "refused" });
      else out.refund.push({ id: i.id, index, key: refundKey(record, i.id), cents: i.left });
    }
    const processing = live.filter((i) => i.status === "processing");
    for (const i of processing) out.pending.push({ id: i.id, index });
    const holds = live.filter((i) => i.status === "requires_capture");
    const open = live.filter((i) => i.status !== "succeeded" && i.status !== "requires_capture" && i.status !== "processing");
    let keep: string | null = null;
    if (late && !paid.length) {
      const good = holds.find((h) => holdGoodUntil(holdTime(h), h.captureBefore) >= input.at);
      const owes = open.find((i) => i.capture === "automatic");
      if (good && (processing.length || blocked)) {
        out.postpone.push({ id: good.id, index, until: holdGoodUntil(holdTime(good), good.captureBefore) });
        keep = good.id;
      } else if (good) {
        out.capture.push({ id: good.id, key: tryKey(record, "capture", good.id) });
        keep = good.id;
      } else if (processing.length || blocked) {
        // Nothing new while one is processing (decided again once it has settled), nor beside a mismatch (reported).
      } else if (live.some((i) => i.status === "succeeded" && i.full)) {
        // Its only payment was refunded in full outside these rules: never charged again without an explicit decision.
        out.blocked.push({ index, why: "refunded", ids: live.filter((i) => i.status === "succeeded" && i.full).map((i) => i.id) });
      } else if (owes) {
        out.owed.push(owes.id);
        keep = owes.id;
      } else if (open.length && !holds.length) {
        // A failed hold: its link ended at the deadline, so the session goes unpaid.
        out.never.push(index);
      } else if (unknownAttempt(record, all, input.at)) {
        const body = record.attemptBody as Readonly<Record<string, string>>;
        out.charge.push({ index, attempt: record.attempt, key: chargeKey(input.series.id, index, record.attempt), capture: body.capture_method === "manual" ? "manual" : "automatic", body });
      } else {
        const attempt = record.attempt + 1;
        out.charge.push({ index, attempt, key: chargeKey(input.series.id, index, attempt), capture: "automatic", body: null });
      }
    } else if (!stays && !(late && paid.length)) out.never.push(index);
    for (const h of holds) if (h.id !== keep) out.close.push(closeStep(h.id, "release", record));
    for (const i of open) if (i.id !== keep) out.close.push(closeStep(i.id, "cancel", record));
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
export function sessionRefunded(record: ChargeRecord, found: readonly FoundIntent[], input: { series: SeriesKey; start: number; at: number; by: "creator" | "buyer"; deadlineHours: number; cancelBy: number }): Refund[] {
  const starts: number[] = [];
  starts[record.index] = input.start;
  const cancelBy: number[] = [];
  cancelBy[record.index] = input.cancelBy;
  return toStop([record.index], [record], { series: input.series, found, starts, at: input.at, by: input.by, deadlineHours: input.deadlineHours, cents: record.cents, cancelBy }).refund;
}

/** What a move comes to for the change message (lib/buyer-words/series-move.ts): read from the charge worked out for the new start and the session's record. */
export type MoveCase = "held_until_start" | "planned" | "kept" | "charged_now" | "paid_refundable_until" | "pay_by_link";

/**
 * Which change message a moved session gets, true to the charge: `kept`
 * when it was charged already and that charge stays (a move never clears
 * it); `held_until_start` when the creator moved it inside its deadline
 * (held now, captured at its start, free to cancel until then);
 * `charged_now` when the buyer moved it inside its deadline (charged at
 * once, kept); `paid_refundable_until` when it was paid already and not
 * kept, and the buyer may still cancel for a full refund until its cancelBy
 * (a paid one whose cancelBy has passed reads as `kept`); `pay_by_link`
 * when its payment failed and still waits on the buyer at the new time:
 * never "your card is only reserved", the pay link instead, which works
 * until payBy of the step that failed (the start for a failed charge or a
 * session the creator moved inside its deadline), never a cancelBy already
 * passed; a failed hold the buyer moved inside the deadline is charged now
 * (`charged_now`), and one moved later is planned again (`planned`);
 * otherwise `planned`, paid as before for the new time. Read from the
 * PaymentIntents just listed (sessionIntents), with `until` the moment the
 * words name and `movedAt` when the move was made.
 */
export function moveCase(series: SeriesKey, record: ChargeRecord, found: readonly FoundIntent[], input: { charge: SeriesCharge; start: number; deadlineHours: number; movedAt: number }): { case: MoveCase; until: number } {
  const { charge, start, deadlineHours, movedAt } = input;
  const live = sessionIntents(series, record, found);
  const at = (which: MoveCase, until = charge.cancelBy) => ({ case: which, until });
  if (record.kept) return at("kept");
  if (live.some((i) => i.status === "succeeded" && !i.full)) return charge.cancelBy > movedAt ? at("paid_refundable_until") : at("kept");
  // Moved by the creator to a start whose deadline had passed: its cancelBy is its start.
  const creatorInside = charge.movedBy === "creator" && charge.way === "hold" && deadlineHours > 0 && charge.captureAt === start && charge.cancelBy === start;
  const best = live[0];
  if (best && best.status !== "requires_capture" && best.status !== "processing") {
    // A failed payment: charged now when the buyer moved it inside the deadline; planned again when its time is later; otherwise its pay link, until payBy of the step that failed.
    if (charge.way === "charge" && !charge.refundFee) return at("charged_now");
    if (charge.at > movedAt) return at("planned");
    const step = best.capture === "manual" ? "hold" : "charge";
    return at("pay_by_link", payBy(start, creatorInside ? 0 : deadlineHours, step));
  }
  if (creatorInside) return at("held_until_start");
  if (charge.way === "charge" && !charge.refundFee) return at("charged_now");
  return at("planned");
}

export type BillingProblem = "deposit" | "code" | "package";

/** Whether a series may be charged this way, or why not. */
export function seriesBillingProblem(input: { deposit: boolean; code: boolean; fromPackage: boolean }): BillingProblem | null {
  if (input.deposit) return "deposit";
  if (input.code) return "code";
  if (input.fromPackage) return "package";
  return null;
}

const same = (a: SeriesCharge, b: SeriesCharge) => a.index === b.index && a.cents === b.cents && a.at === b.at && a.captureAt === b.captureAt && a.way === b.way && a.refundFee === b.refundFee && a.movedBy === b.movedBy && a.cancelBy === b.cancelBy;

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
    ...(deadline
      ? [
          "If you cancel later or miss it, it is not refunded.",
          "If you cancel later and its charge failed, you still owe it.",
          "Once a session is charged at or after its deadline, it is not refunded, even if its time changes later.",
          `If you move a session to less than ${deadline} hours away, it is charged at once and not refunded.`,
          `If ${store} moves a session not charged yet closer than ${deadline} hours, your card is only reserved.`,
          "It is charged when the session starts, and you can cancel for free until then.",
        ]
      : ["If you miss it, it is not refunded."]),
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
