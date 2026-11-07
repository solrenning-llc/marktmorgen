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
import { type Course, type Lesson, isOpen, lessonsInOrder, opensAt } from "@/lib/course";
import { heldBack } from "@/lib/quiz";
import type { ProductFile } from "@/lib/product-file";
import { EPISODE_TYPES, type Episode } from "@/lib/podcast-rules";

/**
 * Public requests on the buyers' side one build of a course's feed, or one
 * lesson's audio fetched, takes from the store's month before the course is
 * read: the store, the listing, the student's access, the course and their
 * passed quizzes at their largest (COURSE_AUDIO_READ in
 * tests/plan-cost-registry.ts, held under these units in
 * tests/plan-cost-registry.test.ts).
 */
export const COURSE_AUDIO_READ_UNITS = 6;

/** The lesson's audio: its first file every podcast app plays, or null. */
export function lessonAudio(lesson: Pick<Lesson, "files">): ProductFile | null {
  return lesson.files.find((f) => (EPISODE_TYPES as readonly string[]).includes(f.contentType)) ?? null;
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

/** The feed's episodes: each lesson by its title, linking to its page when it has text to read. */
export function audioEpisodes(lessons: AudioLesson[], lessonPage: (lessonId: string) => string): Episode[] {
  return lessons.map((l) => ({
    id: l.id,
    title: l.title,
    notes: l.hasBody ? lessonPage(l.id) : "",
    pathname: l.file.pathname,
    bytes: l.file.bytes,
    contentType: l.file.contentType,
    at: l.at,
  }));
}
