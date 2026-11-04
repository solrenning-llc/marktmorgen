/**
 * The studio's "who is on your store now" box (components/stats-panel.tsx,
 * RightNow) asks every half minute, and each ask is one of the store's studio
 * requests, so it stops after LIVE_ASKS of them. What the box says about a
 * next reading comes from the same count that decides whether there is one,
 * so it never promises a reading that will not be made.
 */
export const LIVE_ASKS = 20;

/** Whether another reading will be made after `made` readings. */
export function willReadAgain(made: number): boolean {
  return made < LIVE_ASKS;
}

/** The box has made its last reading (or more): it rests until the page is reloaded. */
export function hasRested(made: number): boolean {
  return !willReadAgain(made);
}

/** The words for a failed reading of today, from the same count as the next reading. */
export function todayFailedWords(made: number): string {
  return willReadAgain(made)
    ? "Today's numbers could not be read on the last try; they are read again in half a minute."
    : "Today's numbers could not be read on the last try; reload the page to read them again.";
}
