/**
 * The facts a course's sales page and its own page say about it (292 [SQ3]),
 * worked out by the code from what is stored, never typed by the creator.
 *
 *   - How many lessons: the course record's own count.
 *   - How long its video runs: the sum of every lesson video's length as the
 *     video service measured it (lib/stream.ts, `seconds` on each video's
 *     record). A lesson with no video adds nothing. When any lesson's video
 *     has no known length (kept in the file store, still being read by the
 *     service, or failed), the total is left out altogether rather than said
 *     as "at least": a figure that leaves a video out is not the course's
 *     length, and nothing here is ever estimated.
 *
 * Not said yet, because nothing true can be said: when the content last
 * changed (no course keeps that; the next unit stamps it at save time) and
 * the creator's switch to hide each fact (the unit after).
 *
 * The read: one MGET of every video's record (courseVideoLengths below, with
 * the record keys and parsing of lib/stream.ts), VIDEO_RECORD_BYTES at the most
 * each, MAX_LESSONS of them; none when the course has no video. The reply is
 * read only in its exact shape (lib/redis-reply.ts, rule 24): one reply for the
 * one command, one row for each key, each row a stored record or null. Any
 * other shape is unknown, and the total is left out, never estimated. The sales page also reads the course record itself:
 * COURSE_FACTS_COMMANDS in all, held inside a later page's commands in
 * tests/sq3-course-facts.test.ts.
 */
import { type Course, lessonCount, lessonsInOrder } from "@/lib/course";
import { coursesWords } from "@/lib/buyer-words/courses";
import { readyStreamSeconds, streamRecordKey } from "@/lib/stream";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";

/** What the sales page sends the database for a course's facts: its record, and its videos' records in one MGET. */
export const COURSE_FACTS_COMMANDS = 2;

export type CourseFacts = {
  lessons: number;
  /** The video's total length in seconds, or null when it cannot be known in full (or there is no video). */
  videoSeconds: number | null;
};

/**
 * How long each of these videos runs, in seconds, by its path: only a video
 * the service has made ready and measured. Every record in one MGET, so a
 * course of any size is one command; a path that is not a video's, or one
 * nothing is known about, is left out. Null with no database, or when the
 * reply is not exactly one row per key, each a stored record or null:
 * then nothing is known.
 */
export async function courseVideoLengths(pathnames: string[]): Promise<Map<string, number> | null> {
  const wanted = pathnames.flatMap((path) => {
    const key = streamRecordKey(path);
    return key ? [{ path, key }] : [];
  });
  if (!isRedisConfigured()) return null;
  const out = new Map<string, number>();
  if (!wanted.length) return out;
  const reply = repliesFor(await redisPipeline([["MGET", ...wanted.map(({ key }) => key)]]), 1);
  const rows = reply ? repliesFor(reply[0], wanted.length) : null;
  if (!rows) return null;
  for (let i = 0; i < wanted.length; i += 1) {
    const row = rows[i];
    if (row !== null && typeof row !== "string") return null;
    const seconds = readyStreamSeconds(wanted[i].path, row);
    if (seconds !== null) out.set(wanted[i].path, seconds);
  }
  return out;
}

/**
 * The sum of the lesson videos' measured lengths; null when the course has
 * no video, when nothing could be read, or when any video's length is unknown.
 */
export function courseVideoSeconds(course: Course, lengths: Map<string, number> | null): number | null {
  if (!lengths) return null;
  const videos = lessonsInOrder(course).flatMap(({ lesson }) => (lesson.video ? [lesson.video.pathname] : []));
  if (!videos.length) return null;
  let total = 0;
  for (const path of videos) {
    const seconds = lengths.get(path);
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
    total += seconds;
  }
  return total;
}

/** A course's facts, read once: its lessons and, when every video's length is known, their total. */
export async function readCourseFacts(course: Course): Promise<CourseFacts> {
  const paths = lessonsInOrder(course).flatMap(({ lesson }) => (lesson.video ? [lesson.video.pathname] : []));
  const lengths = paths.length ? await courseVideoLengths(paths).catch(() => null) : null;
  return { lessons: lessonCount(course), videoSeconds: courseVideoSeconds(course, lengths) };
}

/** "2 hours 15 minutes of video", to the nearest minute, in the store's language; under a minute is said so. */
export function videoTotalLine(seconds: number, language: unknown): string {
  const w = coursesWords(language);
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return w.videoUnderMinute;
  return w.videoTotal(Math.floor(minutes / 60), minutes % 60);
}
