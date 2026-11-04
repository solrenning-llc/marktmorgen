/**
 * The video ceiling of students of a free course (541 [FC4], unit 1; added
 * 1 November 2026), by the owner's decision of 1 November 2026, 11:59
 * Fortaleza: at most 20% of the plan's video hours in its period; the
 * creator may choose less, never more; the rest is for students who paid.
 * The free students' hours come out of the plan's own hours, already
 * counted at their worst, so the ceiling adds no cost.
 *
 * The plan's seconds here are always the store's own limit as playback reads
 * it (lib/plan-standing.ts, videoLimitFor): a store in its free trial has an
 * hour, so its free students have a fifth of that hour at most, never a
 * fifth of the paid plan's hours.
 *
 * What is here: the numbers and the decision made before a free lesson's
 * player is framed, on the figures the meter keeps. What is NOT here, and
 * must be before the rest is reserved for students who paid in fact: the
 * meter reads the video service by the hour (lib/watch.ts) and a player's
 * token lasts hours (lib/stream.ts, PLAYER_SECONDS), so on measured figures
 * alone free students could run past their share before the next reading.
 * The next unit reserves before each free player is framed (the free share
 * taken first, the measured figure only correcting it), keeps the counter of
 * what free students watched, and shows the free lesson's text and files
 * when the share is used. A new kind of record for it waits on the store
 * data registry (tests/store-data-registry.ts, held by an open PR).
 *
 * Browser-safe: plain numbers and pure functions.
 */

/** The owner's maximum, in percent of the plan's video in its period. */
export const FREE_VIDEO_MAX_PERCENT = 20;

/**
 * The creator's choice. Not chosen yet (undefined): the owner's maximum,
 * so a free course works without a setting. A whole percent: kept, never
 * above the maximum. Anything else, which is not a choice the creator
 * could have made: 0, never more.
 */
export function readFreeVideoPercent(raw: unknown): number {
  if (raw === undefined) return FREE_VIDEO_MAX_PERCENT;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,3}$/.test(text)) return 0;
  return Math.min(Number(text), FREE_VIDEO_MAX_PERCENT);
}

/** The seconds free students may watch in the plan's period: the share of the store's own limit, rounded down; null when that limit is not known. */
export function freeVideoSeconds(limitSeconds: number | null, percent: number): number | null {
  if (limitSeconds === null || !Number.isSafeInteger(limitSeconds) || limitSeconds < 0) return null;
  return Math.floor((limitSeconds * readFreeVideoPercent(percent)) / 100);
}

/**
 *   play     both shares have room
 *   paused   used for this period: the video comes back when the plan's next period starts
 *   off      the creator gave free students no video: no promise that it comes back
 *   unknown  a figure could not be read: no player
 */
export type FreeVideoAdmission = "play" | "paused" | "off" | "unknown";

/**
 * Whether a free lesson's video may be framed now, on the measured figures.
 * Both ceilings hold: the free students' own, and the store's whole limit
 * (the free share is part of it). Unknown, from any figure, frames nothing.
 */
export function freeVideoAdmission(input: { limitSeconds: number | null; percent: number; watchedAll: number | null; watchedFree: number | null }): FreeVideoAdmission {
  const share = readFreeVideoPercent(input.percent);
  const cap = freeVideoSeconds(input.limitSeconds, share);
  const count = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
  if (cap === null || input.limitSeconds === null || !count(input.watchedAll) || !count(input.watchedFree)) return "unknown";
  if (share === 0 || cap === 0) return "off";
  if (input.watchedAll >= input.limitSeconds || input.watchedFree >= cap) return "paused";
  return "play";
}

/** A length of video in words: minutes under an hour, so a small share never reads as none. */
function lengthWords(seconds: number): string {
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.floor((seconds / 3600) * 10) / 10;
  return `${hours.toLocaleString("en-US")} ${hours === 1 ? "hour" : "hours"}`;
}

/** What the studio says a choice means, from the store's own limit. */
export function freeVideoWords(limitSeconds: number, percent: number): string {
  const share = readFreeVideoPercent(percent);
  const seconds = freeVideoSeconds(limitSeconds, share) ?? 0;
  if (share === 0 || seconds < 60) return "Students of free courses see each lesson's text and files, without the video.";
  return `Students of free courses can watch up to ${lengthWords(seconds)} of video in each period of your plan, ${share}% of your plan's video. The rest is for students who paid.`;
}
