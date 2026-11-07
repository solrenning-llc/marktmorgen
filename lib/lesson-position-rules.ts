/**
 * Where a student stopped in a lesson video, kept on their own device
 * (650 [WG10], unit 1). Pure rules, read by components/lesson-player.tsx and
 * tested on their own (tests/wg10-lesson-position.test.ts).
 *
 *   - Kept only for a student with access (the page passes the student's own
 *     learner key, lib/learn.ts emailKey: a hash, never the address), under
 *     the course, the lesson and that key, so on a shared computer one
 *     student never sees where another stopped. Never for the creator or a
 *     visitor on a free preview.
 *   - Kept in the browser's own storage: nothing is sent to us, so it costs
 *     nothing on our side and holds nothing of the student's with us. It is
 *     written at most once every SAVE_EVERY_SECONDS while the video plays,
 *     and when it is paused or the page is left.
 *   - Offered back as "Continue at 12:40" beside "Start over", never jumped
 *     to on its own (a change of context only when the person asks).
 *   - Forgotten when the lesson is watched to its end, when the student
 *     starts over, after KEEP_DAYS, and for the whole course once the course
 *     page sees the student's access has ended (a refund, a lost dispute, a
 *     membership ended): components/forget-lesson-positions.tsx.
 *   - The speed the student chose is kept the same way, on the device, and
 *     used for the next lessons.
 */
import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";

/** At most one write while playing in this many seconds (the item's ceiling). */
export const SAVE_EVERY_SECONDS = 15;
/** A place is kept this long after it was last written. */
export const KEEP_DAYS = 90;
/** Closer than this to the start, there is nothing to continue. */
export const MIN_RESUME_SECONDS = 5;
/** Closer than this to the end, the lesson counts as watched. */
export const END_MARGIN_SECONDS = 10;
/** The speeds a student can keep; anything else read back is ignored. */
export const KEPT_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

const PREFIX = "mm:lp:";
export const SPEED_KEY = "mm:lp-speed";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The storage key for one lesson and one student; null when any part is not an id we make. */
export function positionKey(courseId: string, lessonId: string, learner: string): string | null {
  if (!ID.test(courseId) || !ID.test(lessonId) || !/^[0-9a-f]{32}$/.test(learner)) return null;
  return `${PREFIX}${courseId}:${lessonId}:${learner}`;
}

/** Whether a storage key is one of this course's places for this student. */
export function isCoursePlace(key: string, courseId: string, learner: string): boolean {
  if (!ID.test(courseId) || !/^[0-9a-f]{32}$/.test(learner)) return false;
  const start = `${PREFIX}${courseId}:`;
  return key.startsWith(start) && key.endsWith(`:${learner}`) && ID.test(key.slice(start.length, key.length - learner.length - 1));
}

export type Place = { seconds: number; at: number };

/** What was written, read back whole: whole seconds and a time in the past within KEEP_DAYS; anything else is nothing. */
export function readPlace(raw: string | null, nowMs: number): Place | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { s, t } = value as Record<string, unknown>;
  if (typeof s !== "number" || !Number.isSafeInteger(s) || s < 0) return null;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t <= 0 || t > nowMs + 60_000) return null;
  if (nowMs - t > KEEP_DAYS * 86_400_000) return null;
  return { seconds: s, at: t };
}

/** Whether a stored place is to be removed when it is read: there, but too old or not one we wrote (Claude 4 on #2728). */
export function placeToRemove(raw: string | null, nowMs: number): boolean {
  return raw !== null && readPlace(raw, nowMs) === null;
}

/** What is written for a place. */
export function writePlace(seconds: number, nowMs: number): string {
  return JSON.stringify({ s: Math.max(0, Math.floor(seconds)), t: Math.floor(nowMs) });
}

/**
 * Where to offer to continue from, or null: nothing kept, too near the start,
 * or so near the end (once the length is known) that the lesson was watched.
 */
export function resumeFrom(place: Place | null, durationSeconds: number | null): number | null {
  if (!place || place.seconds < MIN_RESUME_SECONDS) return null;
  if (durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    if (place.seconds >= durationSeconds - END_MARGIN_SECONDS) return null;
  }
  return place.seconds;
}

/** Whether a write is due while playing: the first one, or SAVE_EVERY_SECONDS after the last. */
export function saveDue(lastSavedMs: number | null, nowMs: number): boolean {
  return lastSavedMs === null || nowMs - lastSavedMs >= SAVE_EVERY_SECONDS * 1000;
}

/** "12:40", or "1:02:03" past an hour, as a video player shows a time. */
export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** The speed kept on this device, if it is one of KEPT_SPEEDS; otherwise the normal speed. */
export function readSpeed(raw: string | null): number {
  const n = Number(raw);
  return raw !== null && (KEPT_SPEEDS as readonly number[]).includes(n) ? n : 1;
}

/** Whether a speed is one to keep (the player's own menu may offer others, which are used and not kept). */
export function keptSpeed(rate: number): boolean {
  return (KEPT_SPEEDS as readonly number[]).includes(rate);
}

/** The part of the browser's storage this needs: enough to walk and remove keys. */
export type PlaceStorage = Pick<Storage, "length" | "key" | "removeItem">;

/** Removes every place this student has kept in this course on this device; returns how many. Other students' and courses' are left. */
export function forgetCoursePlaces(store: PlaceStorage, courseId: string, learner: string): number {
  const mine: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key !== null && isCoursePlace(key, courseId, learner)) mine.push(key);
  }
  for (const key of mine) store.removeItem(key);
  return mine.length;
}

/** Where the time goes in the resume words: put in on the student's device (sayAt), where the time is read. */
export const RESUME_AT = "{at}";

/**
 * The resume offer's words, plain text only: the lesson page (a Server Component) hands them to the client player, and
 * React's Flight refuses a function crossing that line (Claude 5 on #2728), so the sentences that take the time carry
 * RESUME_AT where it goes.
 */
export type ResumeWords = { label: string; stopped: string; resume: string; startOver: string };

/** The resume offer's words from a language's course words, each sentence with RESUME_AT where the time goes. */
export function resumeWordsOf(w: { resumeLabel: string; resumeStopped: (at: string) => string; resumeContinue: (at: string) => string; resumeStartOver: string }): ResumeWords {
  return { label: w.resumeLabel, stopped: w.resumeStopped(RESUME_AT), resume: w.resumeContinue(RESUME_AT), startOver: w.resumeStartOver };
}

/** A resume sentence with the time put in where RESUME_AT stands. */
export function sayAt(sentence: string, at: string): string {
  return sentence.split(RESUME_AT).join(at);
}

/**
 * The last lesson a student opened, kept on their own device the same way
 * (650 [WG10], unit 2), so their library can offer it back as "Continue where
 * you left off" (components/library-continue.tsx). One record a student,
 * under a code made on our server from their address alone
 * (lib/lesson-position.ts deviceLastKey), holding the lesson page's address,
 * the lesson's, the course's and the store's names, the course id (to forget
 * it with the course) and when. Nothing of it is sent to us.
 */
export const LAST_PREFIX = "mm:ll:";
/** The longest name kept for a lesson, a course or a store; a longer one is cut when written and refused when read. */
export const LAST_TITLE_MOST = 200;
const LAST_RAW_MOST = 2000;
/** A lesson page of this site: the store's handle as lib/store-handle-pattern.ts makes it, then the product and the lesson. */
const LESSON_PATH = new RegExp(`^/@${HANDLE_PATTERN.source.slice(1, -1)}/course/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}$`);

/** The storage key of one student's last lesson; null when the code is not one we make. */
export function lastKey(person: string): string | null {
  return /^[0-9a-f]{32}$/.test(person) ? `${LAST_PREFIX}${person}` : null;
}

/** A lesson page's own address on this site, or null when any part is not one we make. */
export function lessonPath(handle: string, productId: string, lessonId: string): string | null {
  if (!HANDLE_PATTERN.test(handle) || !ID.test(productId) || !ID.test(lessonId)) return null;
  return `/@${handle}/course/${productId}/${lessonId}`;
}

export type LastLesson = { path: string; courseId: string; lesson: string; course: string; store: string; at: number };

const name = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/** What is written for the last lesson; null (nothing written) when its address, course id or a name is not usable. */
export function writeLast(last: Omit<LastLesson, "at">, nowMs: number): string | null {
  const lesson = name(last.lesson);
  const course = name(last.course);
  const store = name(last.store);
  if (!LESSON_PATH.test(last.path) || !ID.test(last.courseId) || !lesson || !course || !store) return null;
  const cut = (text: string) => text.slice(0, LAST_TITLE_MOST);
  return JSON.stringify({ p: last.path, c: last.courseId, l: cut(lesson), n: cut(course), s: cut(store), t: Math.floor(nowMs) });
}

/**
 * The last lesson read back whole, or null: an address that is not a lesson page of this site (so a value changed on
 * the device can never send anyone elsewhere), a name longer than any written, a time in the future or older than
 * KEEP_DAYS, or anything else.
 */
export function readLast(raw: string | null, nowMs: number): LastLesson | null {
  if (typeof raw !== "string" || raw.length > LAST_RAW_MOST) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { p, c, l, n, s, t } = value as Record<string, unknown>;
  if (typeof p !== "string" || !LESSON_PATH.test(p) || typeof c !== "string" || !ID.test(c)) return null;
  const titles = [l, n, s].map(name);
  if (titles.some((title) => title === null || title.length > LAST_TITLE_MOST)) return null;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t <= 0 || t > nowMs + 60_000) return null;
  if (nowMs - t > KEEP_DAYS * 86_400_000) return null;
  const [lesson, course, store] = titles as string[];
  return { path: p, courseId: c, lesson, course, store, at: t };
}

/**
 * Removes this student's last lesson from the device when it is in this course, or when it cannot be read; returns
 * whether it removed it. Another student's, and one in another course, are left.
 */
export function forgetLastIn(store: Pick<Storage, "getItem" | "removeItem">, person: string, courseId: string, nowMs: number): boolean {
  const key = lastKey(person);
  if (!key) return false;
  const raw = store.getItem(key);
  if (raw === null) return false;
  const last = readLast(raw, nowMs);
  if (last && last.courseId !== courseId) return false;
  store.removeItem(key);
  return true;
}
