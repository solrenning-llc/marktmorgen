/**
 * The studio's "who is on your store now" box (components/stats-panel.tsx,
 * RightNow) as a small pure state machine, so what the box says always comes
 * from the same state that decides what it does next.
 *
 * It asks every half minute, and each ask is one of the store's studio
 * requests, so it stops after LIVE_ASKS of them. It rests only when the last
 * of them has come back (an answer or an error). An answer older than one
 * already shown is dropped, and a failed try after a good one is said as that:
 * the numbers still on the screen are from the last good reading, at its time.
 */
export const LIVE_ASKS = 20;
/** A reading that has not come back by then is a failed one (an AbortController in the component), so none stays out for good. */
export const LIVE_TIMEOUT_MS = 10_000;

export type LiveReading<T> = { data: T; at: number };

export type LiveBox<T> = {
  /** Readings started. */
  started: number;
  /** Readings that came back, as an answer or an error. */
  finished: number;
  /** The highest sequence number of a good answer applied, and of a failure: an answer older than the newest good one is dropped. */
  goodSeq: number;
  failSeq: number;
  /** The last good reading and when it was made; null until one comes. */
  last: LiveReading<T> | null;
  /** A failure is newer than the newest good answer. */
  failed: boolean;
  /** The last reading allowed (the 20th) has come back, however many earlier ones are still out. */
  lastBack: boolean;
};

export function newLiveBox<T>(): LiveBox<T> {
  return { started: 0, finished: 0, goodSeq: 0, failSeq: 0, last: null, failed: false, lastBack: false };
}

/** Whether another reading will be started after the ones started so far. */
export function willReadAgain<T>(box: LiveBox<T>): boolean {
  return box.started < LIVE_ASKS;
}

/**
 * The last reading has come back: the box rests until the page is reloaded. A reading that never comes back cannot
 * keep it from resting: the 20th coming back is enough, and every reading ends within LIVE_TIMEOUT_MS anyway.
 */
export function hasRested<T>(box: LiveBox<T>): boolean {
  return !willReadAgain(box) && (box.lastBack || box.finished >= box.started);
}

/** Event: a reading is due. Returns the next box and the reading's sequence number, or null when none is made (tab hidden, or no readings left). */
export function startReading<T>(box: LiveBox<T>, visible: boolean): { box: LiveBox<T>; seq: number } | null {
  if (!visible || !willReadAgain(box)) return null;
  return { box: { ...box, started: box.started + 1 }, seq: box.started + 1 };
}

/** Event: a good answer to reading `seq`, made at `at` (ms). Dropped when a newer good answer already applied. */
export function readingAnswered<T>(box: LiveBox<T>, seq: number, data: T, at: number): LiveBox<T> {
  const finished = box.finished + 1;
  const lastBack = box.lastBack || seq >= LIVE_ASKS;
  // Newer than the newest good answer is enough, even if a newer reading failed: its numbers are the freshest there are.
  if (seq <= box.goodSeq) return { ...box, finished, lastBack };
  return { ...box, finished, lastBack, goodSeq: seq, last: { data, at }, failed: box.failSeq > seq };
}

/** Event: reading `seq` failed. */
export function readingFailed<T>(box: LiveBox<T>, seq: number): LiveBox<T> {
  const finished = box.finished + 1;
  const lastBack = box.lastBack || seq >= LIVE_ASKS;
  const failSeq = Math.max(box.failSeq, seq);
  return { ...box, finished, lastBack, failSeq, failed: failSeq > box.goodSeq };
}

/** "3:41 PM your time": the viewer's own clock, said so, because the day below it is in UTC. */
export function formatReadTime(at: number, timeZone?: string): string {
  return `${new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })} your time`;
}

/** The numbers shown are older than one interval (a tab coming back from the background). */
export const LIVE_EVERY_MS = 30_000;

/**
 * The one status sentence (a live region, WCAG 4.1.3): the count, and when the numbers are not from a reading under
 * way (it failed, the box rests, or they are older than an interval) the time they were read and why.
 */
export function headlineWords<T extends { visitors: number }>(box: LiveBox<T>, timeZone?: string, now?: number): string {
  if (!box.last) return waitingWords(box);
  const v = box.last.data.visitors;
  let text = v === 0 ? "Nobody has opened your store in the last 5 minutes" : `${v.toLocaleString("en-US")} ${v === 1 ? "person has" : "people have"} opened your store in the last 5 minutes`;
  const rested = hasRested(box);
  const old = now !== undefined && now - box.last.at > LIVE_EVERY_MS;
  if (box.failed || rested || old) text += `, as of ${formatReadTime(box.last.at, timeZone)}`;
  if (box.failed) text += rested ? "; the last try failed" : willReadAgain(box) ? "; the last try failed, and it is tried again in half a minute" : "; the last try failed, and one more is under way";
  if (rested) text += "; paused, reload the page to read again";
  if ((box.last.data as { today?: unknown }).today === null) text += "; today's numbers could not be read";
  return text;
}

/** What the box is waiting to do next, in words that cannot promise a reading that will not be made. */
function nextTry<T>(box: LiveBox<T>): string {
  if (hasRested(box)) return "reload the page to read them again";
  if (willReadAgain(box)) return "they are read again in half a minute";
  return "one more try is under way";
}

/** The words for a failed reading of today, from the same state as the next reading. */
export function todayFailedWords<T>(box: LiveBox<T>): string {
  return `Today's numbers could not be read on the last try; ${nextTry(box)}.`;
}

/** The first line, when no reading has been good yet (the box with numbers shows its own count). */
export function waitingWords<T>(box: LiveBox<T>): string {
  if (!box.failed) return "Checking who has opened your store in the last 5 minutes";
  return hasRested(box)
    ? "Who is on your store could not be read; reload the page to try again"
    : willReadAgain(box)
      ? "Who is on your store could not be read just now; it is asked again in half a minute"
      : "Who is on your store could not be read just now; one more try is under way";
}

/** The line under the list: the plain one, the rest, or a failed try after a good reading. */
export function footnoteWords<T>(box: LiveBox<T>, timeZone?: string): string {
  if (hasRested(box)) {
    return box.last && box.failed
      ? `Paused after ten minutes, to save your plan's studio requests. These numbers are from the last good reading, at ${formatReadTime(box.last.at, timeZone)}; the last try failed. Reload the page to see it live again.`
      : "Paused after ten minutes, to save your plan's studio requests. Reload the page to see it live again.";
  }
  if (box.last && box.failed) {
    return `These numbers are from the last good reading, at ${formatReadTime(box.last.at, timeZone)}; the last try to read them again failed${willReadAgain(box) ? ", and it is asked again in half a minute." : "; one more try is under way."}`;
  }
  return "Your store page, each person once, updated every half minute. Nothing about who.";
}
