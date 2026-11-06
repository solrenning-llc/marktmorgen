/** Legacy watched-time billing rules.
 * These are usage and invoice allowances, not verified provider-byte limits.
 * Retries, buffering, replayed links and encoding can cost more than watched time.
 * The existing allowance and postpaid overage price do not establish the owner
 * requirement of 60% net profit after all costs and taxes. Paid release remains
 * subject to the commercial review and enforceable supplier ceilings.
 * File delivery can still incur storage, request and application costs even
 * where the storage provider does not charge Internet egress bandwidth.
 */
/** Historical invoice allowance only. Playback admission is tier-specific in
 * video-admission-rules.ts and plan-standing.ts; do not use this for new grants. */
export const VIDEO_HOURS_INCLUDED = 400;
/** Historical price of an hour past that, in cents. Never charged since 31 October 2026 (232 [CA1] unit 3). */
export const VIDEO_CENTS_PER_HOUR_OVER = 3;

/** The same allowance in seconds, which is what is counted. */
export const VIDEO_SECONDS_INCLUDED = VIDEO_HOURS_INCLUDED * 3600;

/**
 * What a month's watching costs past the allowance, in whole cents.
 *
 * To the second, and rounded down: a part of a cent is never charged.
 */
export function videoOwedCents(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= VIDEO_SECONDS_INCLUDED) return 0;
  return Math.floor(((seconds - VIDEO_SECONDS_INCLUDED) * VIDEO_CENTS_PER_HOUR_OVER) / 3600);
}

/** "12 minutes", "3.5 hours", "412 hours": a length of watching, for a page or an email. */
export function hoursWords(seconds: number): string {
  const counted = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (counted < 3600) {
    const minutes = Math.floor(counted / 60);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = counted / 3600;
  // One decimal while it says something; whole hours past ten.
  const shown = hours < 10 ? Math.floor(hours * 10) / 10 : Math.floor(hours);
  return `${shown.toLocaleString("en-US")} ${shown === 1 ? "hour" : "hours"}`;
}

/** "$0.03", from cents. */
export function centsWords(cents: number): string {
  return `$${(Math.max(0, Math.round(cents)) / 100).toFixed(2)}`;
}

/** "October 2026", from a month written "2026-10". */
export function monthWords(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

/** The month before one written "2026-10". */
export function monthBefore(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const year = Number(match[1]);
  const number = Number(match[2]);
  return number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, "0")}`;
}

/**
 * Whether a store has a plan an hour of video can be added to: one that is
 * paid, and past its free trial. `trialEnds` is in seconds, 0 when not in one.
 */
export function canBeCharged(store: { subscriptionActive: boolean; subscriptionId: string | null; stripeCustomerId: string | null; trialEnds: number }, nowSeconds = Date.now() / 1000): boolean {
  return store.subscriptionActive && Boolean(store.subscriptionId) && Boolean(store.stripeCustomerId) && !(store.trialEnds > nowSeconds);
}

/** The smallest line worth adding to an invoice while the month is still running, in cents. */
export const SMALLEST_LINE_CENTS = 100;

/** How often a store whose video is being watched is measured, and how soon after a lesson is opened. */
export const MEASURE_EVERY_MS = 60 * 60 * 1000;
export const MEASURE_SOON_MS = 10 * 60 * 1000;
