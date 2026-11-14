/**
 * E2, first pure unit: an explicitly supplied community challenge window.
 * This describes instants only. It neither assigns daily tasks nor accepts
 * check-ins, grants points, stores data, or decides a calendar's time zone.
 */

export type ChallengeWindowState = "invalid" | "scheduled" | "active" | "ended";

/** The inclusive endpoints supported by JavaScript dates, in milliseconds. */
const DATE_EDGE = 8_640_000_000_000_000;

function isInstant(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -DATE_EDGE && value <= DATE_EDGE;
}

/**
 * Classifies a known start/end window using only the supplied current instant.
 * The start is included and the end excluded. Malformed instants never become
 * a scheduled, active, or ended challenge through coercion or a guessed clock.
 */
export function challengeWindowState(startsAt: unknown, endsAt: unknown, now: unknown): ChallengeWindowState {
  if (!isInstant(startsAt) || !isInstant(endsAt) || !isInstant(now) || endsAt <= startsAt) return "invalid";
  if (now < startsAt) return "scheduled";
  return now < endsAt ? "active" : "ended";
}

/** A challenge's day: midnight to midnight UTC (lib/community-challenges.ts). */
export const CHALLENGE_DAY_MS = 86_400_000;

/** Which day of a challenge `now` falls on: 0 for its first day, -1 before it. */
export function challengeDay(start: number, now: number): number {
  return now < start ? -1 : Math.floor((now - start) / CHALLENGE_DAY_MS);
}

/** How many days a challenge has. */
export function challengeDays(challenge: { start: number; end: number }): number {
  return Math.max(0, Math.round((challenge.end - challenge.start) / CHALLENGE_DAY_MS));
}

/** A day's date, as YYYY-MM-DD in UTC. */
export function dayDate(start: number, day: number): string {
  return new Date(start + day * CHALLENGE_DAY_MS).toISOString().slice(0, 10);
}

/**
 * The days in a row checked in, counted back from `today` when it is done,
 * else from the day before (today is not missed until it is over). Past the
 * last day, counted back from the last day.
 */
export function streakOf(days: boolean[], today: number): number {
  let day = Math.min(today, days.length - 1);
  if (day >= 0 && day === today && !days[day]) day -= 1;
  let streak = 0;
  for (; day >= 0 && days[day]; day -= 1) streak += 1;
  return streak;
}
