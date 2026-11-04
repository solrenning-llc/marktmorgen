/**
 * Removing affiliates who bring nothing, if the creator asks for it
 * (630 [HN6](3), unit 1; owner's Hotmart audit).
 *
 * A creator may choose that an approved affiliate with no sale and no lead
 * for N days (at least MIN_IDLE_DAYS) is removed from the program on its own,
 * so the list of affiliates stays the people actually promoting. Nobody is
 * removed without warning: the affiliate is told IDLE_WARN_DAYS before, with
 * the date, and one sale or one lead before that date starts the count again.
 *
 * Pure and browser-safe; nothing reads it yet. Unit 2 keeps the creator's
 * choice in the affiliate setting (no new record), works out each affiliate's
 * last sale and lead from the book that is already read, and does what
 * idleStep says in the daily sweep; unit 3 sends the warning (412 [AM7]) and
 * shows the date in the studio and on the affiliate's own page.
 *
 * What removal is, here: the same as the creator pressing "Remove"
 * (lib/affiliates.ts decide). The affiliate keeps their history, what they
 * were already owed is still theirs to be paid, and the creator can restore
 * them, which starts the count again from that day.
 */

const DAY = 86_400;

/** The fewest and most days without a sale or a lead a creator may choose; 0 is off. */
export const MIN_IDLE_DAYS = 90;
export const MAX_IDLE_DAYS = 730;
/** How long before the removal the affiliate is warned, and the least time a warning is given. */
export const IDLE_WARN_DAYS = 14;

/** The creator's choice as kept: off, or 90 to 730 whole days. Anything else is off. */
export function readIdleDays(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= MIN_IDLE_DAYS && n <= MAX_IDLE_DAYS ? n : 0;
}

/** Why a choice sent from the studio is refused, or null: a number out of range is never quietly turned off. */
export function idleProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "" || raw === 0 || raw === "0") return null;
  return readIdleDays(raw) === 0 ? "idle_days" : null;
}

/**
 * What is known about one affiliate. Times in seconds, 0 for never; a time in
 * milliseconds (Affiliate.decidedAt is kept in ms) is read as such, so a value
 * passed straight through cannot silently put the count 50,000 years away.
 *
 *   status    as in lib/affiliates.ts; only "approved" is ever counted;
 *   since     when they were last approved or restored (Affiliate.decidedAt),
 *             so somebody restored is not removed again the same day;
 *   lastSale  when their most recent sale was credited to them, not their own
 *             purchase. A sale refunded or disputed afterward still counts:
 *             activity is never taken back, so a warning already set aside is
 *             never brought back to life by a later refund;
 *   lastLead  when their most recent lead was confirmed (LeadRecord.at),
 *             whatever the creator decided on it later, for the same reason;
 *   warnedAt  when they were last warned, 0 if never: written with the `now`
 *             of the "warn" step, as the warning goes out, so each sweep after
 *             it waits instead of warning again;
 *   onSince   when the creator last switched the choice on or changed its
 *             number of days. A warning given before then is set aside: it
 *             named a date under other terms, so the new terms warn afresh.
 */
export type IdleFacts = {
  status: string;
  since: number;
  lastSale: number;
  lastLead: number;
  warnedAt: number;
  onSince: number;
};

/**
 * What to do about one affiliate now:
 *
 *   "none"    nothing: active, not approved, or the choice is off;
 *   "warn"    send the warning now, saying the removal is on `removeOn`;
 *   "wait"    warned already, and `removeOn` has not come;
 *   "remove"  warned at least IDLE_WARN_DAYS ago, and still nothing since.
 */
export type IdleStep =
  | { do: "none" }
  | { do: "warn"; removeOn: number }
  | { do: "wait"; removeOn: number }
  | { do: "remove" };

/** A time as seconds: whole, positive and finite, or 0; a value that can only be milliseconds is divided. */
function seconds(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n > 1e11 ? n / 1000 : n);
}

/**
 * The step for one affiliate. A warning counts only if it came after their
 * last sale, lead or approval, after the creator last switched the choice on
 * or changed it, and inside the stretch the current choice warns in; anything
 * else needs a fresh warning. The removal is never earlier than the day the
 * warning named, nor sooner than IDLE_WARN_DAYS after it was sent, so a
 * creator who switches this on for a program with long-quiet affiliates gives
 * each of them the full warning first. Switching it off stops everything.
 */
export function idleStep(facts: IdleFacts, idleDays: number | string, now: number): IdleStep {
  const days = readIdleDays(idleDays);
  if (days === 0 || facts.status !== "approved" || !Number.isFinite(now) || now <= 0) return { do: "none" };
  const at = Math.floor(now);
  const last = Math.max(seconds(facts.since), seconds(facts.lastSale), seconds(facts.lastLead));
  // Nothing known at all is not "idle since 1970": without a start, nothing is done.
  if (last === 0) return { do: "none" };
  const due = last + days * DAY;
  const warned = seconds(facts.warnedAt);
  if (warned > last && warned >= seconds(facts.onSince) && warned >= due - IDLE_WARN_DAYS * DAY) {
    const removeOn = Math.max(due, warned + IDLE_WARN_DAYS * DAY);
    return at >= removeOn ? { do: "remove" } : { do: "wait", removeOn };
  }
  if (at < due - IDLE_WARN_DAYS * DAY) return { do: "none" };
  return { do: "warn", removeOn: Math.max(due, at + IDLE_WARN_DAYS * DAY) };
}
