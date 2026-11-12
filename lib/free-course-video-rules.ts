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

/**
 * How long one free student's player may be signed for (541 [FC4], unit 2a;
 * added 2 November 2026): the rule only. The units that use it store the
 * counter and sign the player.
 *
 * What it does: before a free lesson's player is framed, its seconds are
 * taken from the free share (`reservedFree`, every grant of the period
 * added up), never more than what is left of that share, nor of the store's
 * whole limit after what was measured and what free players hold, nor past
 * the end of the period (so a grant never spills into the next one's share),
 * nor more than a paid player is signed for. It is the video's length with
 * FREE_PLAYER_ROOM_SECONDS to pause and go back, or
 * FREE_PLAYER_UNKNOWN_SECONDS when the length is not known; less than
 * FREE_PLAYER_MIN_SECONDS left is "paused", and a grant shorter than the
 * video says so (`short`).
 *
 * What a grant bounds: the time a player may be loaded in, since its token
 * is signed for those seconds. What it does NOT bound, and the units that
 * frame the player must, before the free share can be said to hold:
 *
 *   - the same signed address opened in several tabs or devices at once;
 *   - a player loaded before its token ends playing on after it, and what it
 *     already holds being played again, as long as the video service lets
 *     it (to be read from the service's own documents and a real test of the
 *     library, as lib/watch.ts was; unknown counts as failing);
 *   - playing faster than real time (the player offers speeds): seconds of
 *     video can be more than seconds of clock;
 *   - each reload taking a new grant, which uses the share up for every free
 *     student without anyone watching (one live grant per student and
 *     lesson, reused, is the cure);
 *   - the video of a free preview lesson of a paid course, which plays today
 *     outside this share.
 *
 * A video that is also in a lesson students paid for is to be counted, all
 * of it, as watched by free students, since the video service measures a
 * video, not who watched it: that reading keeps the paid students' time
 * whole. Nothing here measures what free students watched yet.
 */
export const FREE_PLAYER_MAX_SECONDS = 4 * 60 * 60;
export const FREE_PLAYER_ROOM_SECONDS = 5 * 60;
export const FREE_PLAYER_UNKNOWN_SECONDS = 30 * 60;
export const FREE_PLAYER_MIN_SECONDS = 2 * 60;

export type FreePlayerGrant = { kind: "play"; seconds: number; short: boolean } | { kind: "paused" | "off" | "unknown" };

export function freePlayerGrant(input: {
  limitSeconds: number | null;
  percent: number;
  /** What the store's videos were measured to have played this period, all students. */
  watchedAll: number | null;
  /** The free players' seconds already granted this period. */
  reservedFree: number | null;
  /** Seconds until the period ends. */
  periodLeft: number | null;
  /** The lesson video's length in seconds, or null when not known. */
  videoSeconds: number | null;
}): FreePlayerGrant {
  const count = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
  const share = readFreeVideoPercent(input.percent);
  const cap = freeVideoSeconds(input.limitSeconds, share);
  if (cap === null || !count(input.limitSeconds) || !count(input.watchedAll) || !count(input.reservedFree) || !count(input.periodLeft)) return { kind: "unknown" };
  if (share === 0 || cap === 0) return { kind: "off" };
  const leftFree = cap - input.reservedFree;
  // What free players hold may not be measured yet: taken from the whole limit as well, so it is never counted as room.
  const leftAll = input.limitSeconds - input.watchedAll - input.reservedFree;
  // A length with a part of a second is rounded up, never taken for unknown.
  const length = input.videoSeconds !== null && Number.isFinite(input.videoSeconds) && input.videoSeconds > 0 ? Math.ceil(input.videoSeconds) : null;
  const want = length !== null ? length + FREE_PLAYER_ROOM_SECONDS : FREE_PLAYER_UNKNOWN_SECONDS;
  const seconds = Math.min(want, FREE_PLAYER_MAX_SECONDS, leftFree, leftAll, input.periodLeft);
  if (seconds < FREE_PLAYER_MIN_SECONDS) return { kind: "paused" };
  return { kind: "play", seconds, short: seconds < want };
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
