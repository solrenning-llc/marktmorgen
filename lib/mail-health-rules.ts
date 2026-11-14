/**
 * The published lines a store's email is held to (lib/mail-health.ts).
 *
 * They live apart from that file because it opens a Redis connection, and a
 * page that cannot import the real number ends up retyping it. Nothing here
 * reads a setting or a secret, so any page may import it.
 */

/** The days looked back over, today included. */
export const HEALTH_WINDOW_DAYS = 7;
/** How long a store's list email waits once it is over a line. */
export const PAUSE_DAYS = 7;
/** Bounces: at least this many, and at least this share of what was sent. */
export const BOUNCE_FLOOR = 25;
export const BOUNCE_RATE = 0.02;
/** Spam reports: at least this many, and at least this share of what was sent. */
export const COMPLAINT_FLOOR = 5;
export const COMPLAINT_RATE = 0.0008;

/**
 * After addresses are brought in from elsewhere, a store's email goes out in
 * portions that double: this many first, then twice as many, each no sooner
 * than the gap after the one before, until one portion of RAMP_LAST has gone.
 * An import of fewer than RAMP_TRIGGER new addresses starts nothing.
 */
export const RAMP_TRIGGER = 100;
export const RAMP_FIRST = 100;
export const RAMP_LAST = 6_400;
export const RAMP_GAP_MINUTES = 15;

/** How many portions there are, and so about how long the whole of it takes. */
export function rampPortions(): number {
  let n = 0;
  for (let size = RAMP_FIRST; size <= RAMP_LAST; size *= 2) n += 1;
  return n;
}

/** The portions rule in one sentence, for the pages that state it. */
export function rampRuleWords(): string {
  const minutes = rampPortions() * RAMP_GAP_MINUTES;
  const whole = Math.floor(minutes / 60);
  const hours = `${whole} ${whole === 1 ? "hour" : "hours"}${minutes % 60 ? ` ${minutes % 60} minutes` : ""}`;
  return `After you bring in ${RAMP_TRIGGER} or more addresses from elsewhere, your next emails go out in growing portions, ${RAMP_FIRST} people first and twice as many every ${RAMP_GAP_MINUTES} minutes. That way, dead addresses are found while few have been written to. It takes about ${hours} at most, by itself, and after that emails go out at once again.`;
}

const percent = (rate: number) => `${Number((rate * 100).toFixed(2))}%`;

/** The whole rule in one sentence, for the pages that state it. */
export function healthRuleWords(): string {
  return `Email to a store's list pauses for ${PAUSE_DAYS} days, and then goes on by itself, in two cases. One: over ${HEALTH_WINDOW_DAYS} days, ${BOUNCE_FLOOR} or more of its emails and ${percent(BOUNCE_RATE)} or more of them go to addresses that do not exist. Two: over ${HEALTH_WINDOW_DAYS} days, ${COMPLAINT_FLOOR} or more and ${percent(COMPLAINT_RATE)} or more are reported as spam.`;
}
