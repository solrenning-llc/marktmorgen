/**
 * A member pausing their membership instead of cancelling it (added 11
 * October 2026; lib/membership-pause.ts on the server).
 *
 * Read before it was built: Kajabi lets the creator pause somebody by hand
 * (lib/save-offer.ts says where that was read); here the member does it
 * themselves, from the same page they would cancel from, when the creator
 * allows it. Somebody going away for the summer, or short of money for a
 * month, keeps their place rather than leaving for good.
 *
 * How it works, so nobody pays for what they do not get and nobody gets what
 * they did not pay for:
 *
 *   - The pause starts when the period already paid for ends: the member
 *     keeps what they paid for to the last day.
 *   - It lasts the months they chose, up to what the creator allows (1, 2 or
 *     3). Stripe skips the payments in that time (pause_collection, void),
 *     and the membership's doors — its files, its course, its community —
 *     are closed for it, like any membership not being paid for.
 *   - It ends by itself on the day it was set to: Stripe takes the next
 *     payment and the doors open again. Or the member resumes early, which
 *     takes a payment that day and starts a new period from it, so an early
 *     return is never a free stretch of days.
 *   - Only on a membership charged once a month, running normally: not on
 *     one in its free trial, behind on a payment, already set to end, sold
 *     to end after a set number of payments, or paused already. And once a
 *     year at most, so a pause is a break and not a cheaper way to belong.
 *
 * Browser-safe.
 */

/** How long a creator may let members pause for, in months; 0 is off. */
export const PAUSE_CHOICES = [0, 1, 2, 3] as const;

/** A membership may be paused once in this many days. */
export const PAUSE_EVERY_DAYS = 365;

export function parsePauseMonths(raw: unknown): number {
  return (PAUSE_CHOICES as readonly number[]).includes(raw as number) ? (raw as number) : 0;
}

/** The parts of a Stripe subscription a pause reads. */
export type PauseSub = {
  status?: unknown;
  pause_collection?: { behavior?: unknown; resumes_at?: unknown } | null;
  metadata?: Record<string, string> | null;
  cancel_at_period_end?: unknown;
  cancel_at?: unknown;
  current_period_end?: unknown;
  items?: { data?: { current_period_end?: unknown; price?: { recurring?: { interval?: unknown; interval_count?: unknown } | null } }[] };
};

const seconds = (value: unknown) => (typeof value === "string" && /^\d{9,11}$/.test(value) ? Number(value) : typeof value === "number" ? value : 0);

/** When the pause this membership carries starts and ends, in seconds; null when it carries none. */
export function pauseOf(sub: PauseSub): { from: number; until: number } | null {
  const pause = sub.pause_collection;
  if (!pause || typeof pause !== "object") return null;
  const until = seconds(pause.resumes_at);
  const from = seconds(sub.metadata?.pause_from);
  if (!until || !from || until <= from) return null;
  return { from, until };
}

/**
 * Whether Stripe carries a pause on this membership, of any kind, started or still to start, set here or by hand:
 * then nothing that changes what it is paid moves it (lib/tier-switch.ts; the yearly move too, lib/yearly-switch-rules.ts).
 * Stripe voids every invoice under a "void" pause, so a switch's charge would be voided (R43 F4).
 */
export function pauseSet(sub: PauseSub): boolean {
  return Boolean(sub.pause_collection) && typeof sub.pause_collection === "object";
}

/** Whether this membership is paused right now: inside a pause the member chose. Before it starts, they still have what they paid for. */
export function pausedNow(sub: PauseSub, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const pause = pauseOf(sub);
  return pause !== null && nowSeconds >= pause.from && nowSeconds < pause.until;
}

/** When the period already paid for ends, in seconds: on the item since 2025, on the subscription before. */
export function periodEndOf(sub: PauseSub): number {
  const fromItem = sub.items?.data?.[0]?.current_period_end;
  if (typeof fromItem === "number") return fromItem;
  return typeof sub.current_period_end === "number" ? sub.current_period_end : 0;
}

/** A day plus a number of calendar months, at the same time of day; a day past the month's end goes to its last day. */
export function addMonths(atSeconds: number, months: number): number {
  const date = new Date(atSeconds * 1000);
  const day = date.getUTCDate();
  const moved = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()));
  const last = new Date(Date.UTC(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 0)).getUTCDate();
  moved.setUTCDate(Math.min(day, last));
  return Math.floor(moved.getTime() / 1000);
}

export type PauseRefusal = "off" | "interval" | "state" | "ending" | "fixed" | "paused" | "recent";

/** Why this membership cannot be paused now, or null when it can. */
export function cannotPause(sub: PauseSub, allowedMonths: number, nowSeconds = Math.floor(Date.now() / 1000)): PauseRefusal | null {
  if (allowedMonths <= 0) return "off";
  const recurring = sub.items?.data?.[0]?.price?.recurring;
  if (recurring?.interval !== "month" || (recurring.interval_count ?? 1) !== 1) return "interval";
  if (sub.status !== "active") return "state";
  if (sub.cancel_at_period_end === true || (typeof sub.cancel_at === "number" && sub.cancel_at > 0)) return "ending";
  if (sub.metadata?.ends_after) return "fixed";
  if (sub.pause_collection) return "paused";
  const last = seconds(sub.metadata?.paused_at);
  if (last && nowSeconds - last < PAUSE_EVERY_DAYS * 86_400) return "recent";
  if (!periodEndOf(sub)) return "state";
  return null;
}
