/**
 * Copying one of a store's own courses into a new, empty course (294 [SQ5],
 * unit 1; added 7 November 2026): to run the same course again for a new
 * group, or to start a new course from an old one, without retyping it.
 *
 * What comes across: the modules with their titles and opening days, each
 * lesson's title, text, link and whether it is a free preview, and the
 * course's settings (the certificate, how long it stays valid, the email
 * shown over each video). Every module and lesson gets a new id, so nothing a
 * student did in the first course (progress, notes, ratings, comments, quiz
 * tries, handed-in work, certificates) can ever point at the copy, and none
 * of it is read.
 *
 * What does not come across, and is said before and after: videos and
 * downloads (each is a file of the first course's own lesson, which deleting
 * that lesson deletes, so sharing one would lose it), quizzes and
 * assignments (kept apart, for a later unit), and the start date (a new group
 * sets its own). Nothing of the first course changes.
 *
 * What it costs is counted before anything is read, in the store's studio
 * requests, at the same size a request is priced at for a whole store's copy
 * (lib/store-copy-rules.ts, COPY_UNIT_COMMANDS and COPY_UNIT_BYTES): first
 * the other course's listing and record at their largest, then, before the
 * lessons' text is read, every one of those texts read and written at its
 * largest, and the copy's record. What is written takes the store's data
 * room first (lib/course.ts, saveCourse and saveBody).
 *
 * Browser-safe: plain data and pure functions.
 */
import { MAX_BODY_LENGTH, newItemId, type Course, type Lesson } from "@/lib/course";
import { COPY_UNIT_BYTES, COPY_UNIT_COMMANDS } from "@/lib/store-copy-rules";

/** The other course's listing at its largest (lib/catalog.ts MAX_PRODUCT_BYTES; tests/course-copy.test.ts holds them equal). */
export const SOURCE_LISTING_BYTES = 256_000;
/** A course's record at its largest, as the API reads one (lib/api-read-rules.ts COURSE_BYTES). */
export const COURSE_RECORD_BYTES = 512_000;
/** A lesson's text at its largest, three bytes a UTF-16 unit (lib/api-read-rules.ts BODY_BYTES). */
export const LESSON_TEXT_BYTES = MAX_BODY_LENGTH * 3;
/**
 * The commands one lesson's text may send: its share of the read (one
 * command reads many, counted here as one each), and writing it
 * (lib/course.ts saveBody: the GET of what is there, the data room's count of
 * the slot, two, and the SET).
 */
const COMMANDS_PER_TEXT = 5;
/** Writing the copy's record (saveCourse: the data room's two and the SET), the lesson count and hiding it on the store, and the module emails' set. */
const SAVE_COMMANDS = 8;

/** Studio requests for so many commands and bytes, at a request's priced size. */
function units(commands: number, bytes: number): number {
  return Math.max(1, Math.ceil(commands / COPY_UNIT_COMMANDS), Math.ceil(bytes / COPY_UNIT_BYTES));
}

/** Taken before the other course's listing and record are read: both at their largest. */
export const COPY_READ_UNITS = units(2, SOURCE_LISTING_BYTES + COURSE_RECORD_BYTES);
/** The copy's record written at the largest a course's may be. */
export const COPY_SAVE_UNITS = units(SAVE_COMMANDS, COURSE_RECORD_BYTES);
/** One lesson's text read and written at its largest. */
export const COPY_TEXT_UNITS = units(COMMANDS_PER_TEXT, LESSON_TEXT_BYTES * 2);

/** Taken before the lessons' text is read: `texts` of them, and the copy's record. */
export function copyWriteUnits(texts: number): number {
  const n = Number.isSafeInteger(texts) && texts > 0 ? texts : 0;
  return COPY_SAVE_UNITS + n * COPY_TEXT_UNITS;
}

/** Every studio request a copy of a course with `texts` lessons that have text takes. */
export function copyUnits(texts: number): number {
  return COPY_READ_UNITS + copyWriteUnits(texts);
}

/** What the copy leaves out, counted from the other course. */
export type CopyLeft = { videos: number; files: number; quizzes: number; assignments: number; start: boolean };

export type CourseCopy = {
  /** The copy: the target's own id, every module and lesson new. */
  course: Course;
  /** Which lesson's text goes where: the other course's lesson id, the copy's. */
  texts: { from: string; to: string }[];
  left: CopyLeft;
};

/**
 * The other course, `source`, made into the course `target` is (its id),
 * with new ids. `newId` is for the tests: a run of ids that never repeats.
 */
export function copyCourse(source: Course, target: Pick<Course, "id">, newId: () => string = newItemId): CourseCopy {
  const left: CopyLeft = { videos: 0, files: 0, quizzes: 0, assignments: 0, start: source.startsAt !== null };
  const texts: { from: string; to: string }[] = [];
  const used = new Set<string>();
  const fresh = (): string => {
    // A repeated id would make two lessons one: drawn again until it is new.
    for (let i = 0; i < 100; i += 1) {
      const id = newId();
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error("no new id could be drawn");
  };
  const modules = source.modules.map((unit) => ({
    id: fresh(),
    title: unit.title,
    dripDays: unit.dripDays,
    lessons: unit.lessons.map((lesson): Lesson => {
      if (lesson.video) left.videos += 1;
      left.files += lesson.files.length;
      if (lesson.quiz) left.quizzes += 1;
      if (lesson.task) left.assignments += 1;
      const id = fresh();
      if (lesson.hasBody) texts.push({ from: lesson.id, to: id });
      return { id, title: lesson.title, preview: lesson.preview, video: null, files: [], link: lesson.link, hasBody: lesson.hasBody, quiz: null };
    }),
  }));
  const course: Course = {
    id: target.id,
    modules,
    certificate: source.certificate,
    ...(source.certificateMonths ? { certificateMonths: source.certificateMonths } : {}),
    ...(source.stampVideo ? { stampVideo: true } : {}),
    startsAt: null,
  };
  return { course, texts, left };
}

/** The copy with the lessons whose text turned out empty marked as having none, so the outline never says a text is there that is not. */
export function withTexts(copy: Course, written: ReadonlySet<string>): Course {
  return {
    ...copy,
    modules: copy.modules.map((unit) => ({
      ...unit,
      lessons: unit.lessons.map((lesson) => (lesson.hasBody && !written.has(lesson.id) ? { ...lesson, hasBody: false } : lesson)),
    })),
  };
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** What the copy left out, in a sentence each; empty when it left nothing out. */
export function copyLeftWords(left: CopyLeft): string[] {
  const out: string[] = [];
  const missing = [
    left.videos ? count(left.videos, "video", "videos") : "",
    left.files ? count(left.files, "download", "downloads") : "",
    left.quizzes ? count(left.quizzes, "quiz", "quizzes") : "",
    left.assignments ? count(left.assignments, "assignment", "assignments") : "",
  ].filter(Boolean);
  if (missing.length) {
    const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
    out.push(`Not copied: ${list}. Open each lesson and add them again.`);
  }
  if (left.start) out.push("The start date was not copied. Set one under \"The day this course begins\" if this group starts on a set day.");
  return out;
}

/** What the picker says before anything is copied: what comes across, what does not, and what it counts. */
export const COPY_ABOUT =
  "This copies the modules, the lessons' titles and text, their links, which lessons are free previews, when each module opens and the certificate setting. " +
  "It does not copy videos, downloads, quizzes, assignments or the start date. It never copies students, their progress, notes or comments. The other course does not change.";

/** The studio requests a copy counts, said as the code counts them. */
export function copyCostWords(): string {
  return `Copying counts as ${copyUnits(0)} of your studio requests, and ${COPY_TEXT_UNITS} more for each lesson that has text.`;
}

/** What is said once a copy is saved. */
export function copiedWords(copy: Pick<CourseCopy, "course" | "left">): string {
  const lessons = copy.course.modules.reduce((n, unit) => n + unit.lessons.length, 0);
  return [
    `Copied ${count(copy.course.modules.length, "module", "modules")} and ${count(lessons, "lesson", "lessons")}. The course stays hidden from your store until you publish it.`,
    ...copyLeftWords(copy.left),
  ].join(" ");
}
