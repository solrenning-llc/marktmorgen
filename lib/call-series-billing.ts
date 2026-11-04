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
 *     never refunded to the buyer, even if the session is moved later
 *     (keptWhen, ChargeRecord.kept); the creator canceling still refunds it.
 *   - Whether a session was charged is read from its PaymentIntents' state,
 *     never from the time it was due. When sessions are canceled (a series
 *     ending, or one session), toStop says, for each, what is done: never
 *     charged and its open PaymentIntents closed (a hold released, a failed
 *     one canceled); or, when the buyer stopped it after its deadline, its
 *     hold captured, or charged at once when no hold is left to capture, or
 *     its failed late charge left owed on the pay link: a late cancellation
 *     is paid, as promised. The pay link re-reads the session before it
 *     shows anything (payLink). A payment that still succeeds for a session
 *     stopped in time is refunded in full by itself, and a hold placed for
 *     one is released (paidAfterStop).
 *   - A session captured and not yet held when the series ends, or when one
 *     session is canceled: the creator canceling refunds it in full; the
 *     buyer canceling is refunded in full when it is at least the deadline
 *     before the session (the instant itself counts, as 520 [LB1] promises)
 *     and the charge is not kept, and not after. A charge already refunded
 *     is never refunded again.
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
 *     Stripe answers; set `kept` with keptWhen on every capture or charge.
 *   - Before creating, confirming, capturing, canceling or releasing
 *     anything (toStop's steps and the non-payment cancel included), list
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

/** A PaymentIntent as listed on the connected account (with expand[]=data.latest_charge). */
export type FoundIntent = Intent & { metadata: Record<string, string | undefined> };

const RANK: IntentStatus[] = ["succeeded", "requires_capture", "processing", "requires_action", "requires_confirmation", "requires_payment_method"];

/**
 * A session's PaymentIntents that are not canceled, furthest along first:
 * the record's merged with those listed for this series and session. The
 * listed status wins; a hold time or capture_before the list did not carry
 * is kept from the record.
 */
export function sessionIntents(seriesId: string, record: ChargeRecord, found: readonly FoundIntent[]): Intent[] {
  const mine = new Map<string, Intent>();
  if (record.intent) mine.set(record.intent.id, record.intent);
  for (const f of found) {
    if (f.metadata.series !== seriesId || f.metadata.session !== String(record.index)) continue;
    const stored = mine.get(f.id);
    mine.set(f.id, { id: f.id, status: f.status, capture: f.capture, created: f.created, heldAt: f.heldAt ?? stored?.heldAt ?? null, captureBefore: f.captureBefore ?? stored?.captureBefore ?? null });
  }
  return [...mine.values()].filter((i) => i.status !== "canceled").sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status));
}

export type Close = { id: string; action: AfterStop };

/**
 * Whether to reuse a PaymentIntent for a session, create one, or do
 * nothing, at `now`: `found` is the buyer's PaymentIntents listed on the
 * creator's account, every page (the list API, never search). A stopped
 * session never gets a new one. A hold that would not be good at its
 * capture moment is released, never reused. Any other one is reused, the
 * furthest along first, and the rest closed (paidAfterStop says how). Only
 * with none left is one created, under the next attempt's key: a hold
 * before the deadline, a charge at once from it on (never a hold after the
 * deadline).
 */
export function chargeAttempt(
  seriesId: string,
  record: ChargeRecord,
  found: readonly FoundIntent[],
  input: { charge: SeriesCharge; stopped: boolean; now: number },
): { do: "stop" } | { do: "reuse"; id: string; close: Close[] } | { do: "create"; attempt: number; key: string; capture: "manual" | "automatic"; close: Close[] } {
  if (input.stopped) return { do: "stop" };
  const live = sessionIntents(seriesId, record, found);
  const moment = captureMoment(input.charge, input.now);
  const stale = (i: Intent) => i.status === "requires_capture" && holdGoodUntil(holdTime(i), i.captureBefore) < moment;
  const usable = live.filter((i) => !stale(i));
  const close = (keep: string | null) => live.filter((i) => i.id !== keep).map((i) => ({ id: i.id, action: stale(i) ? ("release" as const) : paidAfterStop(i.status) }));
  if (usable.length) return { do: "reuse", id: usable[0].id, close: close(usable[0].id) };
  const attempt = record.attempt + 1;
  const capture = input.charge.way === "hold" && input.now < input.charge.captureAt ? "manual" : "automatic";
  return { do: "create", attempt, key: chargeKey(seriesId, record.index, attempt), capture, close: close(null) };
}

/**
 * Whether a session is canceled for non-payment (at the deadline, or at its
 * start after a failed charge), decided on the PaymentIntents just listed,
 * never on the record alone: a link paid a moment ago (held, processing or
 * paid) keeps the session; otherwise it is canceled and its open
 * PaymentIntents closed.
 */
export function unpaidCancel(seriesId: string, record: ChargeRecord, found: readonly FoundIntent[]): { do: "keep" } | { do: "cancel"; close: string[] } {
  const live = sessionIntents(seriesId, record, found);
  if (live.some((i) => i.status === "succeeded" || i.status === "requires_capture" || i.status === "processing")) return { do: "keep" };
  return { do: "cancel", close: live.map((i) => i.id) };
}

export type AfterStop = "refund_in_full" | "release" | "capture" | "cancel" | "none";

/**
 * What is done with a session's PaymentIntent once the session is stopped,
 * including a payment that comes in after. `paid` is true when the buyer
 * stopped it after its deadline: then what was paid is kept and a hold is
 * captured, as a late cancellation is paid.
 */
export function paidAfterStop(status: IntentStatus, paid = false): AfterStop {
  if (status === "canceled") return "none";
  if (status === "succeeded") return paid ? "none" : "refund_in_full";
  if (status === "requires_capture") return paid ? "capture" : "release";
  // Still open (unpaid, awaiting the buyer, or processing): canceled. If it still succeeds, the rule above decides.
  return "cancel";
}

/**
 * What stopping canceled sessions at `at` does, decided on the
 * PaymentIntents just listed (`found`, every page) merged with the records.
 * `never`: each that must never be charged. `close`: PaymentIntents to
 * close (holds released, failed ones canceled, a duplicate paid one
 * refunded). For sessions the buyer stopped after their deadline (a late
 * cancellation is paid): `capture`, holds still good to capture; `charge`,
 * sessions with no hold left to capture (none placed, canceled, expired),
 * charged at once; `owed`, failed late charges left on their pay link. A
 * session already captured is left to refundsOnEnd.
 */
export function toStop(
  canceled: readonly number[],
  records: readonly ChargeRecord[],
  input: { seriesId: string; found: readonly FoundIntent[]; starts: readonly number[]; at: number; by: "creator" | "buyer"; deadlineHours: number },
): { never: number[]; close: Close[]; capture: string[]; charge: number[]; owed: string[] } {
  const byIndex = new Map(records.map((r) => [r.index, r]));
  const out = { never: [] as number[], close: [] as Close[], capture: [] as string[], charge: [] as number[], owed: [] as string[] };
  for (const index of canceled) {
    const record = byIndex.get(index) ?? { index, cents: 0, attempt: 0, intent: null, refunded: false, kept: false };
    const [best, ...extra] = sessionIntents(input.seriesId, record, input.found);
    // A duplicate is closed whoever stopped and whenever: refunded if paid, released if held.
    for (const e of extra) out.close.push({ id: e.id, action: paidAfterStop(e.status) });
    // After the deadline, by the buyer: paid. At the deadline itself, in time.
    const paid = input.by === "buyer" && input.at > deadlineOf(input.starts[index], input.deadlineHours);
    if (!best) {
      if (paid) out.charge.push(index);
      else out.never.push(index);
      continue;
    }
    if (best.status === "succeeded") continue;
    if (best.status === "requires_capture") {
      if (!paid) {
        out.never.push(index);
        out.close.push({ id: best.id, action: "release" });
      } else if (holdGoodUntil(holdTime(best), best.captureBefore) >= input.at) out.capture.push(best.id);
      else {
        out.close.push({ id: best.id, action: "release" });
        out.charge.push(index);
      }
      continue;
    }
    // Processing after a late stop: kept when it succeeds (paidAfterStop with paid).
    if (best.status === "processing" && paid) continue;
    // A failed late charge (automatic): owed on its link. A failed hold: its link ended at the deadline, so the session goes unpaid.
    if (paid && best.capture === "automatic" && best.status !== "processing") {
      out.owed.push(best.id);
      continue;
    }
    out.never.push(index);
    out.close.push({ id: best.id, action: "cancel" });
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
 * What is refunded when a series ends at `endedAt`: each session captured,
 * not refunded already, and not yet started. A hold is released by toStop,
 * never refunded, and a kept one never to the buyer. `by` says who ended
 * it; `deadlineHours` is the deadline promised when booking, 0 for none.
 */
export function refundsOnEnd(records: readonly ChargeRecord[], starts: readonly number[], endedAt: number, by: "creator" | "buyer", deadlineHours: number): ChargeRecord[] {
  return records.filter((r) => {
    if (r.intent?.status !== "succeeded" || r.refunded) return false;
    if (starts[r.index] <= endedAt) return false;
    if (by === "creator") return true;
    // A charge made at or after the deadline stays kept, even for a session moved later since.
    if (r.kept) return false;
    // At least the deadline before the session, in full, the instant itself included (520 [LB1]: "at least 24 hours before"); later, not.
    return endedAt <= deadlineOf(starts[r.index], deadlineHours);
  });
}

/** Whether one session the buyer or the creator cancels on its own is refunded: the same rule as a series ending, for that session alone. */
export function sessionRefunded(record: ChargeRecord, start: number, canceledAt: number, by: "creator" | "buyer", deadlineHours: number): boolean {
  const starts: number[] = [];
  starts[record.index] = start;
  return refundsOnEnd([record], starts, canceledAt, by, deadlineHours).length === 1;
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
    deadline ? "If you cancel later or miss it, it is not refunded." : "If you miss it, it is not refunded.",
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
