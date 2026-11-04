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
 *     capture_before, or from the hold's own time when Stripe did not say.
 *     A hold that would not last until the deadline (an old one, a session
 *     moved later) is released and placed again; a capture is never moved
 *     earlier than the deadline (captureTime).
 *   - A hold that fails (a card refused, or the bank asking the buyer to
 *     confirm): the buyer is emailed a link to pay, valid only until the
 *     deadline. Unpaid by then, the session is canceled at the deadline, its
 *     time freed, nothing charged. A capture that fails at the deadline (a
 *     hold that expired or was declined) is no fault of the buyer: the
 *     amount is charged at once, off-session; if that fails too, the link
 *     works until the session starts, and unpaid it is canceled at its
 *     start. Both sides are told each step (failedCharge, failedChargeWords).
 *   - Whether a session was charged is read from its PaymentIntent's state,
 *     never from the time it was due. When sessions are canceled (a series
 *     ending, or one session), toStop says, for each, what is done: never
 *     charged and its open PaymentIntent canceled (a hold released, a failed
 *     one closed); or, when the buyer stopped it after its deadline, its
 *     hold captured, or charged at once if no hold was placed: a late
 *     cancellation is paid, as promised. The pay link re-reads the session
 *     before it shows anything (payLink). A payment that still succeeds for
 *     a session stopped in time is refunded in full by itself, and a hold
 *     placed for one is released (paidAfterStop).
 *   - A session captured and not yet held when the series ends, or when one
 *     session is canceled: the creator canceling refunds it in full; the
 *     buyer canceling is refunded in full when it is at least the deadline
 *     before the session (the instant itself counts, as 520 [LB1] promises),
 *     and not after. A charge already refunded is never refunded again.
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
 *     series and session, under chargeKey; write the attempt to the
 *     session's record under its lock before creating it, and the
 *     PaymentIntent's id, status, hold time and capture_before as soon as
 *     Stripe answers.
 *   - Before creating, confirming or capturing anything, list the buyer's
 *     PaymentIntents on the connected account, every page (has_more), and
 *     run chargeAttempt again with them, also right before every capture,
 *     so a duplicate hold made by a racing attempt is closed and never
 *     captured as well.
 *   - Read the session again under its lock before each step: a stopped one
 *     takes only what toStop says.
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

/**
 * What to do with a session's hold at `now`: capture it at the deadline
 * when it is still good then (or at once, once the deadline came, while it
 * is good); otherwise release it and place a new one at the planned time
 * (or now, if that has passed). Never a capture at or after the hold's
 * expiry, and never earlier than the deadline.
 */
export function captureTime(charge: SeriesCharge, hold: { heldAt: number; captureBefore: number | null }, now: number): { do: "capture"; at: number } | { do: "rehold"; at: number } {
  if (charge.way !== "hold") throw new Error("captureTime: only a hold is captured");
  const good = holdGoodUntil(hold.heldAt, hold.captureBefore);
  // At the deadline, or at once if it has passed (a late capture job), and only while the hold is still good.
  const at = Math.max(charge.captureAt, now);
  if (at <= good) return { do: "capture", at };
  return { do: "rehold", at: Math.max(now, charge.at) };
}

/**
 * What a failed payment step comes to. `step` is what failed: the hold
 * (the link works until the deadline, then the session is canceled there);
 * the capture at the deadline (no fault of the buyer: charged at once,
 * off-session); or that charge (the link works until the session starts,
 * then it is canceled at its start).
 */
export function failedCharge(start: number, now: number, deadlineHours: number, step: "hold" | "capture" | "charge"): "pay_by_link" | "charge_now" | "cancel" {
  if (step === "capture") return "charge_now";
  return now < payBy(start, deadlineHours, step) ? "pay_by_link" : "cancel";
}

/** Until when the link to pay works after a failed hold (the deadline) or a failed charge at the deadline (the session's start). */
export function payBy(start: number, deadlineHours: number, step: "hold" | "charge"): number {
  return step === "hold" ? deadlineOf(start, deadlineHours) : start;
}

/** A PaymentIntent's status, as Stripe names it. */
export type IntentStatus = "requires_payment_method" | "requires_confirmation" | "requires_action" | "processing" | "requires_capture" | "succeeded" | "canceled";

/** A session's PaymentIntent as last read: its hold time is its latest charge's creation, and capture_before that charge's, when Stripe said. */
export type Intent = { id: string; status: IntentStatus; heldAt: number | null; captureBefore: number | null };

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
};

/** The key one attempt is created under on the creator's Stripe account. Kept by Stripe for about 24 hours only: a later retry relies on chargeAttempt. */
export function chargeKey(seriesId: string, index: number, attempt: number): string {
  return `series:${seriesId}:${index}:${attempt}`;
}

/** A PaymentIntent as listed on the connected account. */
export type FoundIntent = Intent & { metadata: Record<string, string | undefined> };

const RANK: IntentStatus[] = ["succeeded", "requires_capture", "processing", "requires_action", "requires_confirmation", "requires_payment_method"];

export type Close = { id: string; action: AfterStop };

/**
 * Whether to reuse a PaymentIntent for a session, create one, or do
 * nothing, at `now`: `found` is the buyer's PaymentIntents listed on the
 * creator's account, every page (the list API, never search). A stopped
 * session never gets a new one. A hold that would not be good until the
 * capture is released, never reused. Any other one for this session that is
 * not canceled is reused, the furthest along first, and the rest closed
 * (paidAfterStop says how). Only with none left is one created, under the
 * next attempt's key.
 */
export function chargeAttempt(
  seriesId: string,
  record: ChargeRecord,
  found: readonly FoundIntent[],
  input: { charge: SeriesCharge; stopped: boolean },
): { do: "stop" } | { do: "reuse"; id: string; close: Close[] } | { do: "create"; attempt: number; key: string; close: Close[] } {
  if (input.stopped) return { do: "stop" };
  const mine = new Map<string, Intent>();
  if (record.intent) mine.set(record.intent.id, record.intent);
  for (const f of found) if (f.metadata.series === seriesId && f.metadata.session === String(record.index)) mine.set(f.id, f);
  const live = [...mine.values()].filter((i) => i.status !== "canceled").sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status));
  // A hold whose time is unknown, or that would not be good until the capture, is released: a new one is placed at the planned time.
  const stale = (i: Intent) => i.status === "requires_capture" && (i.heldAt === null || holdGoodUntil(i.heldAt, i.captureBefore) < input.charge.captureAt);
  const usable = live.filter((i) => !stale(i));
  const close = (keep: string | null) => live.filter((i) => i.id !== keep).map((i) => ({ id: i.id, action: stale(i) ? ("release" as const) : paidAfterStop(i.status) }));
  if (usable.length) return { do: "reuse", id: usable[0].id, close: close(usable[0].id) };
  const attempt = record.attempt + 1;
  return { do: "create", attempt, key: chargeKey(seriesId, record.index, attempt), close: close(null) };
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
 * What stopping canceled sessions at `at` does. `never`: each that must
 * never be charged. `cancel`: open PaymentIntents to cancel (holds
 * released, failed ones closed, so no pay link can charge them).
 * `capture`: holds of sessions the buyer stopped after their deadline,
 * captured, since a late cancellation is paid. `charge`: such sessions with
 * no hold placed yet, charged at once. `lookUp`: attempts with no id stored,
 * whose PaymentIntents are listed first and then treated the same way
 * (`paid` true for a late stop). One already captured is left to
 * refundsOnEnd.
 */
export function toStop(
  canceled: readonly number[],
  records: readonly ChargeRecord[],
  input: { starts: readonly number[]; at: number; by: "creator" | "buyer"; deadlineHours: number },
): { never: number[]; cancel: string[]; capture: string[]; charge: number[]; lookUp: { index: number; paid: boolean }[] } {
  const byIndex = new Map(records.map((r) => [r.index, r]));
  const out = { never: [] as number[], cancel: [] as string[], capture: [] as string[], charge: [] as number[], lookUp: [] as { index: number; paid: boolean }[] };
  for (const index of canceled) {
    const r = byIndex.get(index);
    if (r?.intent?.status === "succeeded") continue;
    const paid = input.by === "buyer" && input.at > deadlineOf(input.starts[index], input.deadlineHours);
    if (!r || r.attempt === 0) {
      if (paid) out.charge.push(index);
      else out.never.push(index);
      continue;
    }
    if (!r.intent) {
      out.lookUp.push({ index, paid });
      if (!paid) out.never.push(index);
      continue;
    }
    const action = paidAfterStop(r.intent.status, paid);
    if (action === "capture") {
      out.capture.push(r.intent.id);
      continue;
    }
    out.never.push(index);
    if (action !== "none") out.cancel.push(r.intent.id);
  }
  return out;
}

/**
 * What the link to pay a failed hold or charge does, read again when it is
 * opened and when it is paid: refused once the session is stopped, refused
 * once its PaymentIntent is canceled, refused from `payBy` on, nothing to
 * pay once held or paid; otherwise the buyer pays that same PaymentIntent.
 */
export function payLink(input: { stopped: boolean; status: IntentStatus | null; now: number; payBy: number }): "pay" | "stopped" | "closed" | "late" | "done" {
  if (input.stopped) return "stopped";
  if (input.status === "canceled") return "closed";
  if (input.status === "succeeded" || input.status === "requires_capture" || input.status === "processing") return "done";
  if (input.now >= input.payBy) return "late";
  return "pay";
}

/**
 * What is refunded when a series ends at `endedAt`: each session captured,
 * not refunded already, and not yet started. A hold is released by toStop,
 * never refunded. `by` says who ended it; `deadlineHours` is the deadline
 * promised when booking, 0 for none.
 */
export function refundsOnEnd(records: readonly ChargeRecord[], starts: readonly number[], endedAt: number, by: "creator" | "buyer", deadlineHours: number): ChargeRecord[] {
  return records.filter((r) => {
    if (r.intent?.status !== "succeeded" || r.refunded) return false;
    if (starts[r.index] <= endedAt) return false;
    if (by === "creator") return true;
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
    ...(deadline ? ["If the charge at the deadline fails, the link works until the session starts."] : []),
    deadline ? `Cancel a session at least ${deadline} hours before it starts and you pay nothing for it.` : "Cancel a session any time before it starts and you pay nothing for it.",
    "The reservation is released, and anything already charged is refunded.",
    deadline ? "If you cancel later or miss it, it is not refunded." : "If you miss it, it is not refunded.",
    `If ${store} cancels, you get back what was charged for every session that does not take place.`,
    "This does not affect your rights under the law.",
  ].join(" ");
}

/**
 * What the buyer and the creator are told about a failed payment: when the
 * link is sent (`pay_by_link`), and when the session is canceled unpaid
 * (`cancel`), at the deadline or at its start (`canceledAt`). `date` is the
 * session's day and time as said, `payBy` when the link stops working as
 * said; the buyer is not named.
 */
export function failedChargeWords(input: { to: "buyer" | "creator"; what: "pay_by_link" | "cancel"; date: string; payBy: string; canceledAt: "deadline" | "start" }): string {
  const { to, what, date, payBy } = input;
  const at = input.canceledAt === "deadline" ? "at the cancellation deadline" : "when it was due to start";
  if (what === "pay_by_link") {
    return to === "buyer"
      ? [`Your card could not be charged for your session on ${date}.`, `Pay with the link below by ${payBy}.`, "If it is not paid by then, the session is canceled and you are not charged."].join(" ")
      : [`The buyer's card could not be charged for the session on ${date}.`, `We emailed them a link to pay by ${payBy}.`, "If it is not paid by then, the session is canceled and its time opens again."].join(" ");
  }
  return to === "buyer"
    ? [`Your session on ${date} was canceled ${at}, because it was not paid.`, "You were not charged for it."].join(" ")
    : [`The session on ${date} was canceled ${at}, because it was not paid.`, "Nothing was charged, and its time is open again."].join(" ");
}
