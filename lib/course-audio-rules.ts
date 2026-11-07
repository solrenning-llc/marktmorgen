/**
 * A course's lessons as audio, in each student's own private podcast feed
 * (298 [H5-1]): the rules. Kept and switched in lib/course-audio.ts; read by
 * app/api/store/course/audio (the feed, and each lesson's audio).
 *
 * A lesson's audio is the .mp3 or .m4a the creator attached to it as one of
 * its files, by the same upload and in the same storage as every other lesson
 * file: nothing is converted on the server and no model is asked. A .wav is
 * left out, because most podcast apps do not play it.
 *
 * The feed never holds more than the student may open today, the way the
 * lesson page decides it: a module still waiting on its drip (or a cohort
 * that has not begun) is left out, and so is every lesson behind a required
 * quiz or an assignment the student has not passed yet (lib/quiz.ts,
 * heldBack). The creator's own feed holds every lesson.
 */
import { type Course, type Lesson, MAX_LESSONS, isOpen, lessonsInOrder, opensAt } from "@/lib/course";
import { heldBack } from "@/lib/quiz";
import type { ProductFile } from "@/lib/product-file";
import { EPISODE_TYPES, type Episode } from "@/lib/podcast-rules";

/**
 * How long a lesson's signed audio address works, in seconds: four hours, as
 * a private podcast episode's (app/api/store/podcast/play). A lesson's audio
 * can run longer than an hour, and an app that streams it asks the address it
 * was sent to for each next piece while it plays, often after a pause; a
 * shorter life cuts a lesson off in the middle. Access is asked again every
 * time the door is knocked on, so the switch turned off or a student taken
 * off stops the next fetch at once, and a Stripe refund or an ended
 * membership within ten minutes (Stripe's answer is reused that long,
 * lib/learn.ts PAID_SECONDS); an address already handed out cannot be taken
 * back at any length, and this one ends within four hours.
 */
export const COURSE_AUDIO_URL_SECONDS = 4 * 60 * 60;

/**
 * Lessons one feed may fetch in a day, at the most: each fetch is paid for
 * as a whole build (the course and the student's access are asked again), so
 * an app downloading a long course, or a token passed around, is held to this
 * many a day. An app that is refused tries again later.
 */
export const COURSE_AUDIO_PLAYS_A_DAY = 24;

/**
 * What one public request on the buyers' side pays for of this feed's reads,
 * in each of the things it costs (held in tests/plan-cost-registry.test.ts:
 * each alone costs less than a request).
 */
export const AUDIO_UNIT_COMMANDS = 30;
export const AUDIO_UNIT_BYTES = 1_000_000;
export const AUDIO_UNIT_SENT = 1_000_000;
export const AUDIO_UNIT_STRIPE = 4;

/** Reads to be paid for: database commands, bytes read from it, bytes sent on, and Stripe calls waited on. */
export type AudioWork = { commands: number; bytes: number; sent: number; stripe: number };

/** The public requests that pay for `work`, at least one. */
export function audioUnits(work: AudioWork): number {
  const share = work.commands / AUDIO_UNIT_COMMANDS + work.bytes / AUDIO_UNIT_BYTES + work.sent / AUDIO_UNIT_SENT + work.stripe / AUDIO_UNIT_STRIPE;
  return Math.max(1, Math.ceil(share));
}

/**
 * The second step: the course's record, read up to the size it was measured
 * at, and the size of each of the store's course listings, measured for the
 * third step (one command each).
 */
export function outlineWork(courseBytes: number, courses: number): AudioWork {
  return { commands: 1 + courses, bytes: Math.max(0, courseBytes), sent: 0, stripe: 0 };
}

/** What the access step reads beside the listings: the kept answer, the ledger, imported purchases and the community's level records, each at most this (a review ceiling). */
export const ACCESS_RECORD_BYTES = 64_000;
/** One episode in the feed, at the most, and the feed's own lines (titles at their longest, escaped). */
export const EPISODE_SENT_BYTES = 2_048;
export const FEED_HEAD_BYTES = 8_192;

/**
 * The third step: whether the address may still listen, as every lesson
 * door asks it (lib/learn.ts paidCourses), and the quizzes it passed. For a
 * store with `courses` courses whose listings weigh `listingBytes`: the kept
 * answer, the ledger, imported purchases and the answer kept again (4), the
 * community's levels (4), the course listings read twice when the kept
 * answer has expired (one command each), a blocked check for each course,
 * the passed quizzes (1); the listings twice and the records at
 * ACCESS_RECORD_BYTES; the feed sent at MAX_LESSONS episodes; and, when the
 * kept answer has expired, a page of checkouts for each spelling of the
 * address and three calls for each course to ask whether its purchase was
 * given back (lib/refunds.ts purchaseRefunded). That covers a one-time
 * purchase (no call, or one for the disputes of a charge marked disputed)
 * and a payment plan's usual first invoice (the invoice, its payments and
 * its one payment). Not covered, asked past it: a plan's first invoice whose
 * payment is disputed (one more), one paid in several payments (up to ten,
 * each with its own disputes call), and an address that bought the same
 * course more than once (each purchase asked).
 */
export function accessWork(courses: number, listingBytes: number): AudioWork {
  return {
    commands: 4 + 4 + 2 * courses + courses + 1,
    bytes: 2 * Math.max(0, listingBytes) + 4 * ACCESS_RECORD_BYTES + MAX_LESSONS * 16,
    sent: FEED_HEAD_BYTES + MAX_LESSONS * EPISODE_SENT_BYTES,
    stripe: 2 + 3 * courses,
  };
}

/** The lesson's audio: its first file every podcast app plays, or null. */
export function lessonAudio(lesson: Pick<Lesson, "files">): ProductFile | null {
  return lesson.files.find((f) => (EPISODE_TYPES as readonly string[]).includes(f.contentType)) ?? null;
}

/** Whether the course has this lesson, with audio: asked before anybody's access is. */
export function hasLessonAudio(course: Course, lessonId: string): boolean {
  return lessonsInOrder(course).some(({ lesson }) => lesson.id === lessonId && lessonAudio(lesson) !== null);
}

export type AudioLesson = { id: string; title: string; hasBody: boolean; file: ProductFile; at: number };

/** Who the feed is for: when their course clock started, whether they are the creator, and what they have passed. */
export type Listener = { start: number; owner: boolean; passed: ReadonlySet<string> };

/**
 * The lessons with audio this listener may open now, in the course's order.
 * Each is dated when its module opened for them, plus its place in the
 * course in seconds, so an app that sorts by date keeps the lessons in order.
 */
export function audioLessons(course: Course, who: Listener, nowSeconds = Date.now() / 1000): AudioLesson[] {
  const held = who.owner ? new Map<string, string>() : heldBack(course, new Set(who.passed));
  const out: AudioLesson[] = [];
  lessonsInOrder(course).forEach(({ lesson, unit }, place) => {
    const file = lessonAudio(lesson);
    if (!file) return;
    if (!who.owner && (!isOpen(course, unit, who.start, nowSeconds) || held.has(lesson.id))) return;
    out.push({ id: lesson.id, title: lesson.title, hasBody: lesson.hasBody, file, at: Math.floor(opensAt(course, unit, who.start)) + place });
  });
  return out;
}

/**
 * The feed's episodes: each lesson by its title, linking to its page when it
 * has text to read. No transcript is claimed for a lesson's audio: the
 * lesson's text, linked in the notes, is what it has. Written so it holds
 * whether or not an episode carries a transcript (274 [AX1] B.3).
 */
export function audioEpisodes(lessons: AudioLesson[], lessonPage: (lessonId: string) => string): Episode[] {
  return lessons.map((l) => {
    const episode = Object.assign(
      { id: l.id, title: l.title, notes: l.hasBody ? lessonPage(l.id) : "", pathname: l.file.pathname, bytes: l.file.bytes, contentType: l.file.contentType, at: l.at },
      { transcript: null },
    );
    return episode;
  });
}
