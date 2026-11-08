/**
 * How long a store's lesson videos were watched this month.
 *
 * lib/watch-rules.ts says why this is the measure a plan covers and a bill
 * is made from. This file keeps it.
 *
 * The video service counts, for every video, the seconds it has been watched
 * since it was put there (lib/stream.ts, streamWatched). That is a running
 * total and not a month's, so what is kept here is the last total seen for
 * each video, and each reading adds what a video grew by since the one
 * before to the month it is read in:
 *
 *   nl:watch:last:<folder>          each video's total when last read
 *   nl:watch:sec:<folder>:<month>   seconds watched, added up, that month
 *   nl:watch:folders:<month>        the stores that had any, that month
 *   nl:watch:due                    which stores to read, and when
 *   nl:watch:opened:<folder>        when a lesson video of theirs last opened
 *
 * Read by the hour, and only where somebody is watching. A lesson page that
 * frames a video says so (opened), which puts the store in line to be read
 * ten minutes on and every hour after, until nothing of its has been opened
 * for longer than a player's token lasts. A store nobody watches is never
 * asked about.
 *
 * What this errs toward. A video that is deleted takes with it whatever was
 * watched since its last reading, at most an hour's worth: never counted,
 * never charged. A total that goes down, which the service does not do, adds
 * nothing. A reading that fails adds nothing and is made again. Every one of
 * those is in the creator's favor, which is the way round a figure that is
 * billed from has to err.
 *
 * So does the player's own count, as it was seen on the live library on
 * October 7, 2026. A lesson played once from start to end, 24 seconds, was
 * counted as 24 seconds, and this file read the service's total to the
 * second. A sitting that began where the viewer had stopped the time
 * before, a second from the end, and then played the video three times
 * over, was counted as 10: the player stops counting once a video has
 * reached its end. What it counts is watching, never more than there was.
 *
 * A reading belongs to the month it is made in, so the last hour of a month
 * can land in the next. It is still counted once.
 */
import { storeKeysOf } from "@/lib/delivery";
import { WINDOW_ID, allowanceWindow, calendarWindow } from "@/lib/allowance-window";
import { storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { textCountOf } from "@/lib/redis-count";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { PLAYER_SECONDS, isStreamConfigured, streamWatched } from "@/lib/stream";
import { MEASURE_EVERY_MS, MEASURE_SOON_MS } from "@/lib/watch-rules";

const lastKey = (folder: string) => `nl:watch:last:${folder}`;
const secondsKey = (folder: string, month: string) => `nl:watch:sec:${folder}:${month}`;
const foldersKey = (month: string) => `nl:watch:folders:${month}`;
const openedKey = (folder: string) => `nl:watch:opened:${folder}`;
const DUE = "nl:watch:due";

/** A month's figures are kept long enough to be billed, asked about and answered for. */
const KEEP_SECONDS = 400 * 24 * 60 * 60;
/** After a lesson was last opened, how long its store goes on being read: a token's life, and an hour over. */
const WATCHING_FOR_MS = (PLAYER_SECONDS + 3600) * 1000;
/** A reading that failed is made again this soon. */
const AGAIN_MS = 15 * 60 * 1000;

const FOLDER_PATTERN = /^[0-9a-f]{32}$/;

/**
 * A lesson video of this store was just framed for somebody. Puts the store
 * in line to be read, if it is not in line already.
 *
 * Never throws: a line that cannot be written must not cost a student the
 * lesson they opened.
 */
export async function opened(folder: string, now = Date.now()): Promise<void> {
  if (!isRedisConfigured() || !FOLDER_PATTERN.test(folder)) return;
  try {
    await redisPipeline([
      ["SET", openedKey(folder), String(now), "EX", 7 * 24 * 60 * 60],
      // NX: a store already in line keeps its place.
      ["ZADD", DUE, "NX", now + MEASURE_SOON_MS, folder],
    ]);
  } catch (error) {
    console.error("could not put a store in line to be measured", error);
  }
}

/**
 * The seconds of video a store's students watched in a month ("2026-10");
 * this month by default. Throws (UnknownReplyError, or the database's own
 * error) when the count cannot be read in its exact shape: an unknown month
 * is never 0 seconds (audit SG2, CX-123 rule 24). The hourly job's loop over
 * stores catches it and leaves that store for the next round.
 */
export async function watchedIn(folder: string, month = calendarWindow().id): Promise<number> {
  if (!isRedisConfigured() || !folder) return 0;
  const seconds = textCountOf(repliesFor(await redisPipeline([["GET", secondsKey(folder, month)]]), 1)?.[0]);
  if (seconds === null) throw new UnknownReplyError("a month's video seconds");
  // No key is the meter's way of saying nothing was watched that month yet.
  return seconds === "absent" ? 0 : seconds;
}

/** Admission reads must distinguish an acknowledged unused month from a failed
 * lookup. The watchedIn reader (the hourly job's notices, billing history)
 * throws on a failed lookup and is never permission to issue a limited
 * playback token; this one answers null instead.
 * A missing monthly key is the existing meter's representation of no recorded
 * usage; this reader does not prove meter freshness or protect against key loss.
 */
export async function watchedForAdmission(folder: string, month = calendarWindow().id): Promise<number | null> {
  if (!isRedisConfigured() || !FOLDER_PATTERN.test(folder) || !WINDOW_ID.test(month)) return null;
  try {
    const results = await redisPipeline([["GET", secondsKey(folder, month)]]);
    if (results.length !== 1) return null;
    const raw = results[0];
    if (raw === null) return 0;
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    if (typeof raw === "string" && !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
  } catch { return null; }
}

/** The stores whose video was watched at all in a month. */
export async function watchedFolders(month = calendarWindow().id): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["SMEMBERS", foldersKey(month)]]);
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string" && FOLDER_PATTERN.test(f)).sort() : [];
}

/**
 * The window a folder's store counts its video in: its billing month when it
 * pays and the period is known, the calendar month otherwise (watching that
 * happened is counted somewhere, never nowhere).
 */
async function windowOfFolder(folder: string, now: number): Promise<string> {
  try {
    const [key] = await storeKeysOf([folder]);
    const store = key ? await storeForEmail(key) : null;
    if (store && (await storeFolder(storeRef(store))) === folder) return (allowanceWindow(store, now) ?? calendarWindow(now)).id;
  } catch (error) {
    console.error("could not read whose video was watched", error);
  }
  return calendarWindow(now).id;
}

/**
 * Reads one store at the video service and adds what was watched since the
 * reading before. Answers the seconds added; null when the service, or the
 * last totals kept here, could not be read, and then nothing was changed.
 */
export async function measure(folder: string, now = Date.now()): Promise<number | null> {
  if (!isRedisConfigured() || !FOLDER_PATTERN.test(folder)) return 0;
  const videos = await streamWatched(folder);
  if (videos === null) return null;

  // Each video's last total, only in its exact shape (audit SG2, CX-123 rule
  // 24). A total read as 0 would count the whole video again, so a reply
  // that is not a list of text fields and values measures nothing this
  // round: null, read again soon, as when the service could not be read.
  const flat = stringList(repliesFor(await redisPipeline([["HGETALL", lastKey(folder)]]), 1)?.[0]);
  if (flat === null || flat.length % 2 !== 0) return null;
  const last = new Map<string, number>();
  // A well-formed reply can still hold one entry that is not a whole number
  // ("12.5", an old format, a deleted video's). It is persisted and never
  // expires, so refusing the whole store on it would stop the metering for
  // good (review 1 of SG2 L8). That entry alone is dropped: its previous
  // total is not known, so nothing is added for it this round (never counted
  // from 0) and it is rewritten with the current total below, or let go with
  // the videos that are gone. At most one interval of one video goes uncounted.
  const resync = new Set<string>();
  for (let i = 0; i < flat.length; i += 2) {
    const seconds = textCountOf(flat[i + 1]);
    if (typeof seconds === "number") last.set(flat[i], seconds);
    else resync.add(flat[i]);
  }
  if (resync.size) console.error(`a store's last watch totals held ${resync.size} malformed entr${resync.size === 1 ? "y" : "ies"}; resynced without counting them (watch ${folder})`);

  let added = 0;
  const writes: (string | number)[][] = [];
  const there = new Set<string>();
  for (const video of videos) {
    there.add(video.id);
    if (resync.has(video.id)) {
      writes.push(["HSET", lastKey(folder), video.id, video.seconds]);
      continue;
    }
    const before = last.get(video.id);
    // A video seen for the first time was put there since the reading before
    // (or before any reading was made): all of its watching is new.
    if (video.seconds > (before ?? 0)) added += video.seconds - (before ?? 0);
    if (before === undefined || video.seconds !== before) writes.push(["HSET", lastKey(folder), video.id, video.seconds]);
  }
  // A video that is gone is forgotten, so this does not grow for ever.
  const gone = [...last.keys(), ...resync].filter((id) => !there.has(id));
  if (gone.length) writes.push(["HDEL", lastKey(folder), ...gone]);

  if (added > 0) {
    // Added to the store's window (lib/allowance-window.ts), where its video
    // stops; the line of stores is kept by the calendar month.
    const window = await windowOfFolder(folder, now);
    const month = calendarWindow(now).id;
    writes.push(
      ["INCRBY", secondsKey(folder, window), added],
      ["EXPIRE", secondsKey(folder, window), KEEP_SECONDS],
      ["SADD", foldersKey(month), folder],
      ["EXPIRE", foldersKey(month), KEEP_SECONDS],
    );
  }
  if (writes.length) await redisPipeline(writes);
  return added;
}

/**
 * The hourly reading, run from the five-minute video job: reads each store
 * that is due, the longest-waiting first. Stops at `deadline`; what is left
 * is still due, and is first in line next time.
 */
export async function measureDue(deadline: number, now = Date.now()): Promise<{ read: number; seconds: number }> {
  const counts = { read: 0, seconds: 0 };
  if (!isRedisConfigured() || !isStreamConfigured()) return counts;
  const [due] = await redisPipeline([["ZRANGEBYSCORE", DUE, 0, now, "LIMIT", 0, 60]]);
  for (const folder of Array.isArray(due) ? due : []) {
    if (Date.now() > deadline) return counts;
    if (typeof folder !== "string") continue;
    const added = await measure(folder, now);
    if (added === null) {
      await redisPipeline([["ZADD", DUE, now + AGAIN_MS, folder]]);
      continue;
    }
    counts.read += 1;
    counts.seconds += added;
    // No key: no lesson of theirs opened for a week. A reply of any other
    // shape is unknown, and keeps the store in line rather than letting
    // its watching go unread (audit SG2, CX-123 rule 24).
    const openedAt = textCountOf(repliesFor(await redisPipeline([["GET", openedKey(folder)]]), 1)?.[0]);
    const still = openedAt === null || (openedAt !== "absent" && now - openedAt < WATCHING_FOR_MS);
    // Read once more after the last token has run out, and then left alone
    // until a lesson is opened again.
    await redisPipeline([still ? ["ZADD", DUE, now + MEASURE_EVERY_MS, folder] : ["ZREM", DUE, folder]]);
  }
  return counts;
}
