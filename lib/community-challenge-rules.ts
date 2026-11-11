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
