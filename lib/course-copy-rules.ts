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
import { templateFits } from "@/lib/course-templates";

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
/**
 * The copy's record is written twice (first without text, so no text is ever
 * kept that no record points at; then with it), and the empty one is written
 * back when a later write fails: each the data room's two and the SET. With
 * the lock held before each write, the lesson count, hiding the product and
 * putting it back, and the module emails' set.
 */
const SAVE_COMMANDS = 16;
/** The empty course written back, at its largest: one module with no lesson. */
const EMPTY_COURSE_BYTES = 4_096;

/** Studio requests for so many commands and bytes, at a request's priced size. */
function units(commands: number, bytes: number): number {
  return Math.max(1, Math.ceil(commands / COPY_UNIT_COMMANDS), Math.ceil(bytes / COPY_UNIT_BYTES));
}

/** Taken before the other course's listing and record are read: both at their largest. */
export const COPY_READ_UNITS = units(2, SOURCE_LISTING_BYTES + COURSE_RECORD_BYTES);
/** The copy's record written twice at the largest a course's may be, and the empty one back. */
export const COPY_SAVE_UNITS = units(SAVE_COMMANDS, 2 * COURSE_RECORD_BYTES + EMPTY_COURSE_BYTES);
/** One lesson's text read and written at its largest. */
export const COPY_TEXT_UNITS = units(COMMANDS_PER_TEXT, LESSON_TEXT_BYTES * 2);

/** Taken before the lessons' text is read: `texts` of them, and the copy's record. */
export function copyWriteUnits(texts: number): number {
  const n = Number.isSafeInteger(texts) && texts > 0 ? texts : 0;
  return COPY_SAVE_UNITS + n * COPY_TEXT_UNITS;
}

/**
 * The community's search (lib/community-index.ts): the exact writes that make
 * the copied lessons findable, counted by their commands and their bytes, for
 * a store with a community. Each lesson is new, so nothing of it is in the
 * search yet and nothing needs reading first. None when there are none.
 */
export function copyIndexUnits(writes: (string | number)[][]): number {
  if (!writes.length) return 0;
  const encoder = new TextEncoder();
  const bytes = writes.reduce((sum, command) => sum + command.reduce<number>((n, part) => n + encoder.encode(String(part)).length, 0), 0);
  return units(writes.length, bytes);
}

/**
 * Whether a course may be copied into: exactly as it was made (templateFits),
 * and without a certificate validity or the email over videos set, which the
 * copy would write over.
 */
export function copyFits(course: Pick<Course, "modules" | "certificate" | "startsAt" | "certificateMonths" | "stampVideo">): boolean {
  return templateFits(course).ok && !course.certificateMonths && !course.stampVideo;
}

/** Every studio request a copy of a course with `texts` lessons that have text takes, its community's search apart. */
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
  "This copies the modules, the lessons' titles and text, their links, which lessons are free previews, when each module opens, whether students get a certificate, how long certificates stay valid and whether the email shown over each video is on. " +
  "It does not copy videos, downloads, quizzes, assignments or the start date. It never copies students, their progress, notes or comments. The other course does not change.";

/** The most words the search keeps for one lesson (lib/community-search.ts MAX_INDEXED_WORDS; tests/course-copy.test.ts holds them equal). */
export const SEARCH_WORDS_PER_LESSON = 600;

/** Said before the button: the product leaves the store first. */
export const COPY_HIDES = "Copying takes this course off your store first. It stays hidden until you publish it.";

/** The yes a course on the store needs before it is taken off it. */
export const COPY_CONFIRM = "Yes, take this course off my store while I finish it.";

/** Said after the rest when the copy is saved but its lessons could not all be put in the community's search. */
export const COPY_NOT_FINDABLE = "Some lessons could not be added to your community's search. Save each lesson again to add it.";

/** Said when the copy is saved but a step after it did not finish. */
export const COPY_AFTER_SAVE = "The copy is saved, but its lesson count or its module emails could not be updated. Reload the page and check the course.";

/** The studio requests a copy counts, said as the code counts them; with a community, the search's part too. */
export function copyCostWords(community: boolean): string {
  const base = `Copying counts as ${copyUnits(0)} of your studio requests, and ${COPY_TEXT_UNITS} more for each lesson that has text.`;
  return community
    ? `${base} Your community's search counts 1 more for every ${COPY_UNIT_COMMANDS} entries it writes: each different word of a lesson, at most ${SEARCH_WORDS_PER_LESSON}, and the lesson itself. The exact number is checked before anything is copied.`
    : base;
}

/** What is said once a copy is saved. */
export function copiedWords(copy: Pick<CourseCopy, "course" | "left">, notes: string[] = []): string {
  const lessons = copy.course.modules.reduce((n, unit) => n + unit.lessons.length, 0);
  return [
    `Copied ${count(copy.course.modules.length, "module", "modules")} and ${count(lessons, "lesson", "lessons")}. The course stays hidden from your store until you publish it.`,
    ...copyLeftWords(copy.left),
    ...notes,
  ].join(" ");
}
