/**
 * Courses: a product whose delivery is a set of lessons, grouped in modules.
 *
 * The outline — modules, lessons, which video and files each lesson has — is
 * kept in a record of its own rather than on the store, because a store page
 * is read on every visit and a course with two hundred lessons would make
 * every one of those reads heavier for nothing. The text of each lesson is
 * kept apart again, so opening one lesson never loads all the others.
 *
 * Files live in the same private store as everything else a creator sells,
 * under a folder named after the lesson, and leave it only through a signed
 * link made for someone who may see them.
 *
 * Pure rules at the top, storage at the bottom.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { readShelf } from "@/lib/course-shelf-rules";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { indexBytes } from "@/lib/community-search";
import { type DataStore, giveData, needData, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { type ProductFile, parseProductFile } from "@/lib/product-file";
import { type QuizSetup, parseSetup as parseQuizSetup } from "@/lib/quiz";
import { type TaskSetup, parseTaskSetup } from "@/lib/assignment-rules";
import { randomLetters } from "@/lib/random-letters";
import { UnknownReply, exactReplies } from "@/lib/redis-exact";

export const MAX_MODULES = 30;
export const MAX_LESSONS = 200;
export const MAX_LESSON_FILES = 5;
export const MAX_ITEM_TITLE = 120;
export const MAX_BODY_LENGTH = 10_000;
export const MAX_DRIP_DAYS = 365;

/**
 * The window a course start date may fall in: 2020, to five years out.
 *
 * A date is the only thing on a course that students are held behind, so a
 * typo in it is a course nobody can open. The floor catches a date typed in
 * milliseconds by mistake, which would land in 1970 and open everything at
 * once; the ceiling catches one typed in seconds where milliseconds were
 * meant, which would hold the course shut for fifty thousand years.
 */
export const EARLIEST_START = 1_577_836_800; // 2020-01-01
export function latestStart(nowSeconds = Date.now() / 1000): number {
  return Math.floor(nowSeconds) + 5 * 365 * 86_400;
}

/** Videos a lesson can play in every current browser. */
export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

export const COURSE_ID_PATTERN = /^[0-9a-f]{32}$/;
export const ITEM_ID_PATTERN = /^[a-z0-9]{12}$/;

export type Lesson = {
  id: string;
  title: string;
  /** Open to anyone from the store page, as a taste of the course. */
  preview: boolean;
  video: ProductFile | null;
  /** Downloads that go with the lesson: worksheets, slides, templates. */
  files: ProductFile[];
  /** A page elsewhere the lesson points to, when it has one. */
  link: string | null;
  /** Whether the lesson has text, so the outline can say so without loading it. */
  hasBody: boolean;
  /**
   * The lesson's quiz, when it has one: how many questions, the pass mark,
   * the tries allowed and whether it holds later lessons shut. The questions
   * themselves are kept apart (lib/quiz.ts).
   */
  quiz: QuizSetup | null;
  /**
   * The lesson's assignment, when it has one: whether the creator approves
   * each, whether it holds later lessons shut, whether a file may be handed
   * in. Its prompt is kept apart (lib/assignment.ts). A lesson has a quiz or
   * an assignment, not both.
   */
  task?: TaskSetup | null;
};

export type CourseModule = {
  id: string;
  title: string;
  /**
   * Days after the course's clock starts before this module opens. 0 opens
   * it the moment the clock starts. Where that clock starts is the course's
   * business, not the module's: see `startsAt` below.
   */
  dripDays: number;
  lessons: Lesson[];
};

export type Course = {
  id: string;
  modules: CourseModule[];
  /**
   * Whether a student who finishes gets a certificate of completion
   * (lib/certificate.ts). Off until the creator switches it on.
   */
  certificate: boolean;
  /**
   * The products shown to students on the course's home page under "More
   * from <store>" (628 [HN4](b), lib/course-shelf-rules.ts), in the creator's
   * order. Absent is none.
   */
  shelf?: string[];
  /**
   * How long a certificate issued from now on stays valid, in months
   * (639 [GL7](32)), for a training that has to be renewed; absent is for
   * good, as for every course before it. Fixed on each certificate when it
   * is issued, so changing it later never changes one already given.
   */
  certificateMonths?: number;
  /**
   * Whether each lesson video shows the signed-in student's email and the
   * day they joined over it (602 [WP1], lib/video-stamp.ts). Off until the
   * creator switches it on; left out of courses saved before it existed.
   */
  stampVideo?: boolean;
  /**
   * The day the course begins, in seconds, or null for a course with no
   * fixed start. This is the one thing that decides whether a course is a
   * cohort or not, and it changes nothing else about it.
   *
   * null — the clock starts when each student pays. Everyone gets the same
   * weeks in the same order, each counted from their own joining day, so a
   * student who buys in March and one who buys in July are both in week one
   * on their first day. This is what every course here was until now, and
   * what a course stays unless a date is set.
   *
   * A date — the clock starts then, once, for everybody. Module one opens
   * on that morning and not before, however early somebody bought; week
   * three opens three weeks later for the whole room at the same time. A
   * student who joins after the start finds everything up to that moment
   * already open and waits with the rest for what comes next. That is the
   * whole of what makes a cohort: one clock instead of one per student.
   *
   * A date in the past is allowed and is not a mistake — it is a course
   * already running, taking late joiners.
   */
  startsAt: number | null;
};

export function newCourseId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Twelve lowercase letters and digits: short enough for a URL, unique in practice. */
export function newItemId(): string {
  return randomLetters("abcdefghijklmnopqrstuvwxyz0123456789", 12);
}

function cleanTitle(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return text.slice(0, MAX_ITEM_TITLE) || fallback;
}

function parseLesson(raw: unknown): Lesson | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !ITEM_ID_PATTERN.test(value.id)) return null;
  const files = Array.isArray(value.files)
    ? value.files.map(parseProductFile).filter((f): f is ProductFile => f !== null).slice(0, MAX_LESSON_FILES)
    : [];
  return {
    id: value.id,
    title: cleanTitle(value.title, "Untitled lesson"),
    preview: value.preview === true,
    video: parseProductFile(value.video),
    files,
    link: typeof value.link === "string" && value.link ? value.link.slice(0, 2000) : null,
    hasBody: value.hasBody === true,
    // Lessons written before quizzes existed have none.
    quiz: parseQuizSetup(value.quiz),
    ...(value.task ? { task: parseTaskSetup(value.task) } : {}),
  };
}

function parseModule(raw: unknown): CourseModule | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !ITEM_ID_PATTERN.test(value.id)) return null;
  const drip = Number(value.dripDays);
  return {
    id: value.id,
    title: cleanTitle(value.title, "Untitled module"),
    dripDays: Number.isInteger(drip) && drip >= 0 && drip <= MAX_DRIP_DAYS ? drip : 0,
    lessons: Array.isArray(value.lessons)
      ? value.lessons.map(parseLesson).filter((l): l is Lesson => l !== null)
      : [],
  };
}

/** The longest a certificate may stay valid: ten years. */
export const MAX_CERTIFICATE_MONTHS = 120;

/** A validity as typed or kept: a whole number of months from 1 to 120, or null. */
export function readCertificateMonths(raw: unknown): number | null {
  const n = typeof raw === "string" && raw.trim() ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_CERTIFICATE_MONTHS ? n : null;
}

export function parseCourse(raw: unknown): Course | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.id !== "string" || !COURSE_ID_PATTERN.test(value.id)) return null;
    const modules = Array.isArray(value.modules)
      ? value.modules.map(parseModule).filter((m): m is CourseModule => m !== null).slice(0, MAX_MODULES)
      : [];
    const startsAt =
      typeof value.startsAt === "number" && Number.isFinite(value.startsAt) ? Math.floor(value.startsAt) : null;
    const shelf = readShelf(value.shelf);
    const months = readCertificateMonths(value.certificateMonths);
    return { id: value.id, modules, certificate: value.certificate === true, ...(months ? { certificateMonths: months } : {}), startsAt, ...(value.stampVideo === true ? { stampVideo: true } : {}), ...(shelf.length ? { shelf } : {}) };
  } catch {
    return null;
  }
}

/** Every lesson, in the order a student meets them. */
export function lessonsInOrder(course: Course): { lesson: Lesson; unit: CourseModule }[] {
  return course.modules.flatMap((unit) => unit.lessons.map((lesson) => ({ lesson, unit })));
}

export function lessonCount(course: Course): number {
  return course.modules.reduce((sum, unit) => sum + unit.lessons.length, 0);
}

export function findLesson(course: Course, lessonId: string): { lesson: Lesson; unit: CourseModule } | null {
  for (const unit of course.modules) {
    const lesson = unit.lessons.find((l) => l.id === lessonId);
    if (lesson) return { lesson, unit };
  }
  return null;
}

/**
 * Where a student's clock starts: the cohort's date, or their own joining.
 *
 * Everything about cohorts is this one line. The rest of the course does not
 * know or care which kind it is.
 */
export function dripStart(course: Pick<Course, "startsAt">, joinedSeconds: number): number {
  return course.startsAt ?? joinedSeconds;
}

/** Whether a course runs to one date for everyone rather than to each student's own. */
export function isCohort(course: Pick<Course, "startsAt">): boolean {
  return course.startsAt !== null;
}

/**
 * When a module opens for a student who joined at `joinedSeconds`.
 *
 * The course is the first argument, and it is required, so that no caller
 * can work out a drip date without it. That is deliberate: the older pair of
 * these took the module and a start and nothing else, and adding cohorts to
 * that shape would have meant finding nine call sites by hand and being
 * right about all nine. A module opening a week early for a late joiner is
 * not something anybody would notice from a screenshot. Written this way the
 * compiler finds them instead.
 */
export function opensAt(course: Pick<Course, "startsAt">, unit: CourseModule, joinedSeconds: number): number {
  return dripStart(course, joinedSeconds) + unit.dripDays * 86_400;
}

export function isOpen(
  course: Pick<Course, "startsAt">,
  unit: CourseModule,
  joinedSeconds: number,
  nowSeconds = Date.now() / 1000,
): boolean {
  // On a rolling course, "no wait" means open the moment they are in. On a
  // cohort, day zero is a real day: a student who bought three weeks early
  // waits for it with everyone else.
  if (!isCohort(course) && unit.dripDays === 0) return true;
  return opensAt(course, unit, joinedSeconds) <= nowSeconds;
}

/** Whether a cohort has not begun yet, so a student is waiting for day one. */
export function beforeStart(course: Pick<Course, "startsAt">, nowSeconds = Date.now() / 1000): boolean {
  return course.startsAt !== null && course.startsAt > nowSeconds;
}

/** Every stored file a course holds, so nothing is left behind when it goes. */
export function filesInCourse(course: Course): ProductFile[] {
  return lessonsInOrder(course).flatMap(({ lesson }) => [
    ...(lesson.video ? [lesson.video] : []),
    ...lesson.files,
  ]);
}

export type CourseEdit =
  | { op: "module-add"; title: unknown }
  | { op: "module-edit"; moduleId: string; title: unknown; dripDays: unknown }
  | { op: "module-move"; moduleId: string; direction: "up" | "down" }
  | { op: "module-remove"; moduleId: string }
  | { op: "lesson-add"; moduleId: string; title: unknown }
  | { op: "lesson-edit"; lessonId: string; title: unknown; preview: unknown; link: string | null; hasBody?: boolean }
  | { op: "lesson-move"; lessonId: string; direction: "up" | "down" }
  | { op: "lesson-remove"; lessonId: string }
  | { op: "media"; lessonId: string; kind: "video" | "file"; file: ProductFile }
  | { op: "media-remove"; lessonId: string; pathname: string }
  | { op: "quiz"; lessonId: string; quiz: QuizSetup | null }
  | { op: "task"; lessonId: string; task: TaskSetup | null }
  | { op: "certificate"; on: boolean }
  /** The "More from" shelf (628 [HN4](b)): product ids, the course's own product left out. */
  | { op: "shelf"; products: unknown; courseProductId: string }
  /** How long certificates issued from now on stay valid: 1 to 120 months, or null for good. */
  | { op: "certificate-months"; months: unknown }
  | { op: "start"; at: unknown }
  /** Several modules at once, each with its lessons by title: an outline taken from the writing help (lib/ai.ts). */
  | { op: "outline"; modules: { title: unknown; lessons: unknown[] }[] };

export type EditResult =
  | { ok: true; course: Course; removed: ProductFile[]; addedId?: string }
  | { ok: false; reason: "unknown" | "too_many" | "not_empty" | "drip" | "files" | "video_type" | "start" | "months" };

function mapLesson(course: Course, lessonId: string, change: (lesson: Lesson) => Lesson): Course | null {
  let found = false;
  const modules = course.modules.map((unit) => ({
    ...unit,
    lessons: unit.lessons.map((lesson) => {
      if (lesson.id !== lessonId) return lesson;
      found = true;
      return change(lesson);
    }),
  }));
  return found ? { ...course, modules } : null;
}

/**
 * Applies one change from the studio. Pure: what to store and which files
 * are no longer used come back, and the caller writes and deletes.
 */
export function editCourse(course: Course, edit: CourseEdit): EditResult {
  const modules = course.modules;
  switch (edit.op) {
    case "module-add": {
      if (modules.length >= MAX_MODULES) return { ok: false, reason: "too_many" };
      const id = newItemId();
      const unit: CourseModule = {
        id,
        title: cleanTitle(edit.title, `Module ${modules.length + 1}`),
        dripDays: 0,
        lessons: [],
      };
      return { ok: true, course: { ...course, modules: [...modules, unit] }, removed: [], addedId: id };
    }
    case "module-edit": {
      const at = modules.findIndex((m) => m.id === edit.moduleId);
      if (at < 0) return { ok: false, reason: "unknown" };
      const drip = typeof edit.dripDays === "string" && edit.dripDays.trim() === "" ? 0 : Number(edit.dripDays);
      if (!Number.isInteger(drip) || drip < 0 || drip > MAX_DRIP_DAYS) return { ok: false, reason: "drip" };
      const next = [...modules];
      next[at] = { ...next[at], title: cleanTitle(edit.title, next[at].title), dripDays: drip };
      return { ok: true, course: { ...course, modules: next }, removed: [] };
    }
    case "module-move": {
      const at = modules.findIndex((m) => m.id === edit.moduleId);
      if (at < 0) return { ok: false, reason: "unknown" };
      const to = edit.direction === "up" ? at - 1 : at + 1;
      if (to < 0 || to >= modules.length) return { ok: true, course, removed: [] };
      const next = [...modules];
      [next[at], next[to]] = [next[to], next[at]];
      return { ok: true, course: { ...course, modules: next }, removed: [] };
    }
    case "module-remove": {
      const unit = modules.find((m) => m.id === edit.moduleId);
      if (!unit) return { ok: false, reason: "unknown" };
      // Lessons are removed one by one, on purpose: a module full of work
      // should never vanish in one press.
      if (unit.lessons.length > 0) return { ok: false, reason: "not_empty" };
      return { ok: true, course: { ...course, modules: modules.filter((m) => m.id !== edit.moduleId) }, removed: [] };
    }
    case "outline": {
      const adding = edit.modules.filter((m) => Array.isArray(m.lessons));
      const newLessons = adding.reduce((n, m) => n + m.lessons.length, 0);
      if (!adding.length) return { ok: false, reason: "unknown" };
      if (modules.length + adding.length > MAX_MODULES || lessonCount(course) + newLessons > MAX_LESSONS) {
        return { ok: false, reason: "too_many" };
      }
      const made: CourseModule[] = adding.map((m, i) => ({
        id: newItemId(),
        title: cleanTitle(m.title, `Module ${modules.length + i + 1}`),
        dripDays: 0,
        lessons: m.lessons.map((title, n) => ({
          id: newItemId(),
          title: cleanTitle(title, `Lesson ${n + 1}`),
          preview: false,
          video: null,
          files: [],
          link: null,
          hasBody: false,
          quiz: null,
        })),
      }));
      return { ok: true, course: { ...course, modules: [...modules, ...made] }, removed: [] };
    }
    case "lesson-add": {
      if (lessonCount(course) >= MAX_LESSONS) return { ok: false, reason: "too_many" };
      const at = modules.findIndex((m) => m.id === edit.moduleId);
      if (at < 0) return { ok: false, reason: "unknown" };
      const id = newItemId();
      const lesson: Lesson = {
        id,
        title: cleanTitle(edit.title, `Lesson ${modules[at].lessons.length + 1}`),
        preview: false,
        video: null,
        files: [],
        link: null,
        hasBody: false,
        quiz: null,
      };
      const next = [...modules];
      next[at] = { ...next[at], lessons: [...next[at].lessons, lesson] };
      return { ok: true, course: { ...course, modules: next }, removed: [], addedId: id };
    }
    case "lesson-edit": {
      const next = mapLesson(course, edit.lessonId, (lesson) => ({
        ...lesson,
        title: cleanTitle(edit.title, lesson.title),
        preview: edit.preview === true,
        link: edit.link,
        hasBody: edit.hasBody ?? lesson.hasBody,
      }));
      return next ? { ok: true, course: next, removed: [] } : { ok: false, reason: "unknown" };
    }
    case "lesson-move": {
      const mi = modules.findIndex((m) => m.lessons.some((l) => l.id === edit.lessonId));
      if (mi < 0) return { ok: false, reason: "unknown" };
      const li = modules[mi].lessons.findIndex((l) => l.id === edit.lessonId);
      const next = modules.map((m) => ({ ...m, lessons: [...m.lessons] }));
      const lesson = next[mi].lessons[li];
      if (edit.direction === "up") {
        if (li > 0) {
          [next[mi].lessons[li - 1], next[mi].lessons[li]] = [lesson, next[mi].lessons[li - 1]];
        } else if (mi > 0) {
          // The first lesson of a module moves to the end of the one before.
          next[mi].lessons.splice(li, 1);
          next[mi - 1].lessons.push(lesson);
        }
      } else if (li < next[mi].lessons.length - 1) {
        [next[mi].lessons[li + 1], next[mi].lessons[li]] = [lesson, next[mi].lessons[li + 1]];
      } else if (mi < next.length - 1) {
        // The last lesson of a module moves to the start of the next.
        next[mi].lessons.splice(li, 1);
        next[mi + 1].lessons.unshift(lesson);
      }
      return { ok: true, course: { ...course, modules: next }, removed: [] };
    }
    case "lesson-remove": {
      const found = findLesson(course, edit.lessonId);
      if (!found) return { ok: false, reason: "unknown" };
      const removed = [...(found.lesson.video ? [found.lesson.video] : []), ...found.lesson.files];
      return {
        ok: true,
        course: {
          ...course,
          modules: modules.map((m) => ({ ...m, lessons: m.lessons.filter((l) => l.id !== edit.lessonId) })),
        },
        removed,
      };
    }
    case "media": {
      const found = findLesson(course, edit.lessonId);
      if (!found) return { ok: false, reason: "unknown" };
      if (edit.kind === "video") {
        if (!VIDEO_TYPES.includes(edit.file.contentType)) return { ok: false, reason: "video_type" };
        const previous = found.lesson.video;
        const next = mapLesson(course, edit.lessonId, (lesson) => ({ ...lesson, video: edit.file }));
        return next
          ? { ok: true, course: next, removed: previous && previous.pathname !== edit.file.pathname ? [previous] : [] }
          : { ok: false, reason: "unknown" };
      }
      if (found.lesson.files.length >= MAX_LESSON_FILES) return { ok: false, reason: "files" };
      const next = mapLesson(course, edit.lessonId, (lesson) => ({ ...lesson, files: [...lesson.files, edit.file] }));
      return next ? { ok: true, course: next, removed: [] } : { ok: false, reason: "unknown" };
    }
    case "media-remove": {
      const found = findLesson(course, edit.lessonId);
      if (!found) return { ok: false, reason: "unknown" };
      const { lesson } = found;
      if (lesson.video?.pathname === edit.pathname) {
        const next = mapLesson(course, edit.lessonId, (l) => ({ ...l, video: null }));
        return { ok: true, course: next as Course, removed: [lesson.video] };
      }
      const file = lesson.files.find((f) => f.pathname === edit.pathname);
      if (!file) return { ok: false, reason: "unknown" };
      const next = mapLesson(course, edit.lessonId, (l) => ({ ...l, files: l.files.filter((f) => f.pathname !== edit.pathname) }));
      return { ok: true, course: next as Course, removed: [file] };
    }
    case "quiz": {
      const next = mapLesson(course, edit.lessonId, (lesson) => ({ ...lesson, quiz: edit.quiz }));
      return next ? { ok: true, course: next, removed: [] } : { ok: false, reason: "unknown" };
    }
    case "task": {
      const next = mapLesson(course, edit.lessonId, (lesson) => {
        const { task: _was, ...rest } = lesson;
        void _was;
        return edit.task ? { ...rest, task: edit.task } : rest;
      });
      return next ? { ok: true, course: next, removed: [] } : { ok: false, reason: "unknown" };
    }
    case "certificate":
      return { ok: true, course: { ...course, certificate: edit.on }, removed: [] };
    case "shelf": {
      const shelf = readShelf(edit.products, edit.courseProductId);
      const { shelf: _was, ...rest } = course;
      void _was;
      return { ok: true, course: shelf.length ? { ...rest, shelf } : rest, removed: [] };
    }
    case "certificate-months": {
      if (edit.months === null || edit.months === 0 || edit.months === "") {
        const rest = { ...course };
        delete rest.certificateMonths;
        return { ok: true, course: rest, removed: [] };
      }
      const months = readCertificateMonths(edit.months);
      if (!months) return { ok: false, reason: "months" };
      return { ok: true, course: { ...course, certificateMonths: months }, removed: [] };
    }
    case "start": {
      if (edit.at === null) return { ok: true, course: { ...course, startsAt: null }, removed: [] };
      const at = typeof edit.at === "number" ? Math.floor(edit.at) : Number.NaN;
      if (!Number.isFinite(at) || at < EARLIEST_START || at > latestStart()) {
        return { ok: false, reason: "start" };
      }
      return { ok: true, course: { ...course, startsAt: at }, removed: [] };
    }
  }
}

// ---------------------------------------------------------------- storage

const courseKey = (id: string) => `nl:course:${id}`;
const bodyKey = (id: string, lessonId: string) => `nl:course:${id}:body:${lessonId}`;

export function emptyCourse(id: string = newCourseId()): Course {
  return { id, modules: [{ id: newItemId(), title: "Module 1", dripDays: 0, lessons: [] }], certificate: false, startsAt: null };
}

export async function readCourse(id: string): Promise<Course | null> {
  if (!isRedisConfigured() || !COURSE_ID_PATTERN.test(id)) return null;
  const [raw] = await redisPipeline([["GET", courseKey(id)]]);
  return parseCourse(raw);
}

/**
 * Reads one course while preserving the difference between confirmed absence
 * and an incomplete or unreadable storage reply. Destructive callers use this
 * before removing the only identity that lets a later request try again.
 */
export async function readCourseExact(id: string): Promise<Course | null> {
  const what = "the course being removed";
  if (!isRedisConfigured() || !COURSE_ID_PATTERN.test(id)) throw new UnknownReply(what);
  const [raw] = exactReplies(await redisPipeline([["GET", courseKey(id)]]), 1, what);
  if (raw === null) return null;
  const course = parseCourse(raw);
  if (!course || course.id !== id) throw new UnknownReply(what);
  return course;
}

/** Several at once, for the pages that show every course of a store. */
export async function readCourses(ids: string[]): Promise<Map<string, Course>> {
  const found = new Map<string, Course>();
  const valid = ids.filter((id) => COURSE_ID_PATTERN.test(id));
  if (!isRedisConfigured() || valid.length === 0) return found;
  // A hundred at a command (MGET), not a command each: a store's whole export reads every course (lib/store-export.ts).
  for (let i = 0; i < valid.length; i += 100) {
    const some = valid.slice(i, i + 100);
    const [rows] = await redisPipeline([["MGET", ...some.map(courseKey)]]);
    some.forEach((id, n) => {
      const course = parseCourse(Array.isArray(rows) ? rows[n] : null);
      if (course) found.set(id, course);
    });
  }
  return found;
}

/**
 * readCourses, read exactly (rule 24), for a person's deletion
 * (lib/person-erasure.ts erasureScope) and a store's whole export
 * (lib/store-export.ts): a course is left out only when Redis answers the
 * exact null for it. A reply that is not a whole list of the ids asked, or an
 * outline kept but unreadable, throws UnknownReply, so the deletion never
 * takes an unknown read for "no such course" and answers done while the
 * person's records in that course are still kept, and an export never hands
 * over a file without a course as if the store had none. `what` names the
 * reading in the error.
 */
export async function readCoursesExact(ids: string[], what = "the course outlines a person's deletion goes through"): Promise<Map<string, Course>> {
  const found = new Map<string, Course>();
  const valid = [...new Set(ids.filter((id) => COURSE_ID_PATTERN.test(id)))];
  if (valid.length === 0) return found;
  if (!isRedisConfigured()) throw new UnknownReply(what);
  // A hundred at a command, as readCourses: the same commands, so the deletion's counted cost does not move.
  for (let i = 0; i < valid.length; i += 100) {
    const some = valid.slice(i, i + 100);
    const [rows] = exactReplies(await redisPipeline([["MGET", ...some.map(courseKey)]]), 1, what);
    const each = exactReplies(rows, some.length, what);
    some.forEach((id, n) => {
      if (each[n] === null) return;
      const course = parseCourse(each[n]);
      if (!course || course.id !== id) throw new UnknownReply(what);
      found.set(id, course);
    });
  }
  return found;
}

/**
 * Where a course is counted in the store's data room (lib/store-data.ts):
 * its outline in one slot, its lessons' text in another, each lesson's words
 * as the community's search may index them (lib/community-index.ts) included.
 */
const OUTLINE_SLOT = (id: string) => `co:${id}`;
const BODIES_SLOT = (id: string) => `cb:${id}`;
const bodyBytes = (text: string) => (text ? dataBytes([text], 1) + indexBytes([text]) : 0);

/**
 * Writes a course's outline, after taking its room (DataRoomError when it
 * does not fit). `always` counts it whatever it comes to: what a job writes
 * that only takes things out (lib/plan-closing.ts).
 */
export async function saveCourse(course: Course, room: DataStore, always = false): Promise<void> {
  const json = JSON.stringify(course);
  const changes = [{ slot: OUTLINE_SLOT(course.id), bytes: dataBytes([json], 1) + indexBytes(lessonsInOrder(course).map(({ lesson, unit }) => `${lesson.title} ${unit.title}`)), set: true }];
  if (always) await noteData(room, changes);
  else await needData(room, changes);
  await redisPipeline([["SET", courseKey(course.id), json]]);
}

export async function readBody(courseId: string, lessonId: string): Promise<string> {
  if (!isRedisConfigured() || !COURSE_ID_PATTERN.test(courseId) || !ITEM_ID_PATTERN.test(lessonId)) return "";
  const [raw] = await redisPipeline([["GET", bodyKey(courseId, lessonId)]]);
  return typeof raw === "string" ? raw : "";
}

/**
 * A lesson's text read in its exact shape, for a caller that writes from it
 * (lib/community-index.ts): "" only when there is none (an absent key), the
 * text when it is one, and UnknownReplyError for any other reply, so an odd
 * or partial answer is never taken as a lesson with no text (CX-123 rule 24).
 */
export async function readBodyKnown(courseId: string, lessonId: string): Promise<string> {
  if (!isRedisConfigured() || !COURSE_ID_PATTERN.test(courseId) || !ITEM_ID_PATTERN.test(lessonId)) return "";
  const replies = repliesFor(await redisPipeline([["GET", bodyKey(courseId, lessonId)]]), 1);
  const raw = replies?.[0];
  if (raw === null) return "";
  if (typeof raw === "string") return raw;
  throw new UnknownReplyError("a lesson's text");
}

/**
 * A lesson's text read exactly, for the studio's editor (rule 24): the text, ""
 * when none is kept, and null when the reply is neither, so an unknown read is
 * never opened as an empty lesson whose Save would write over the real text.
 */
export async function readBodyExact(courseId: string, lessonId: string): Promise<string | null> {
  if (!isRedisConfigured() || !COURSE_ID_PATTERN.test(courseId) || !ITEM_ID_PATTERN.test(lessonId)) return null;
  const replies = await redisPipeline([["GET", bodyKey(courseId, lessonId)]]);
  if (!Array.isArray(replies) || replies.length !== 1) return null;
  const [raw] = replies;
  return typeof raw === "string" ? raw : raw === null ? "" : null;
}

/** Many lessons' text at once, a hundred to a command: for a store's whole export (lib/store-export.ts). */
/** Lesson bodies read together, across courses: how many a command. Each is at most MAX_BODY_LENGTH, so one command carries a few megabytes at the most. */
export const BODIES_PER_READ = 500;

/**
 * The text of every lesson of these courses, by course and lesson, BODIES_PER_READ at a command whatever course each is of (lib/store-export.ts).
 * Read exactly (rule 24): "" only for Redis's own null; a reply that is not one list of exactly the keys asked, or a
 * value that is not text, throws UnknownReply, so the export says the part could not be read instead of writing the
 * lesson out empty in the file a creator takes before the store closes.
 */
export async function readAllBodies(courses: { id: string; lessons: string[] }[]): Promise<Map<string, Record<string, string>>> {
  const what = "the lessons' text a store's export reads";
  const out = new Map<string, Record<string, string>>();
  const wanted = courses.filter((c) => COURSE_ID_PATTERN.test(c.id)).flatMap((c) => {
    out.set(c.id, {});
    return c.lessons.filter((id) => ITEM_ID_PATTERN.test(id)).map((lesson) => ({ course: c.id, lesson }));
  });
  if (wanted.length === 0) return out;
  if (!isRedisConfigured()) throw new UnknownReply(what);
  for (let i = 0; i < wanted.length; i += BODIES_PER_READ) {
    const some = wanted.slice(i, i + BODIES_PER_READ);
    const [raw] = exactReplies(await redisPipeline([["MGET", ...some.map((w) => bodyKey(w.course, w.lesson))]]), 1, what);
    const values = exactReplies(raw, some.length, what);
    some.forEach((w, n) => {
      const value = values[n];
      if (value !== null && typeof value !== "string") throw new UnknownReply(what);
      out.get(w.course)![w.lesson] = value ?? "";
    });
  }
  return out;
}

export async function readBodies(courseId: string, lessonIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const ids = lessonIds.filter((id) => ITEM_ID_PATTERN.test(id));
  if (!isRedisConfigured() || !COURSE_ID_PATTERN.test(courseId)) return out;
  for (let i = 0; i < ids.length; i += 100) {
    const some = ids.slice(i, i + 100);
    const [raw] = await redisPipeline([["MGET", ...some.map((id) => bodyKey(courseId, id))]]);
    some.forEach((id, n) => {
      const value = Array.isArray(raw) ? raw[n] : null;
      out[id] = typeof value === "string" ? value : "";
    });
  }
  return out;
}

/** Writes a lesson's text, taking what it grows by first (DataRoomError when it does not fit). */
export async function saveBody(courseId: string, lessonId: string, text: string, room: DataStore): Promise<void> {
  const next = text.slice(0, MAX_BODY_LENGTH);
  const before = await readBody(courseId, lessonId);
  const grown = bodyBytes(next) - bodyBytes(before);
  if (grown > 0) await needData(room, [{ slot: BODIES_SLOT(courseId), bytes: grown }]);
  if (next) await redisPipeline([["SET", bodyKey(courseId, lessonId), next]]);
  else await redisPipeline([["DEL", bodyKey(courseId, lessonId)]]);
  if (grown < 0) await giveData(room, [{ slot: BODIES_SLOT(courseId), bytes: -grown }]);
}

/**
 * Deletes the key only while it holds exactly this value, in one step on the
 * Redis side: 1 deleted, 0 left. The same script, line for line, as
 * lib/redis-lock.ts RELEASE, so the tests' Redis (lib/redis-memory.ts) runs
 * the same check.
 */
const DELETE_IF_SAME = '-- marktmorgen:release:v1\nif redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

/**
 * The lesson texts of a course made by an import (260 [KJ5], lib/course-import-apply.ts),
 * written at once: each text already as the editor keeps it (cleanBody), for
 * a lesson id given once. The room for all of them is taken in one step
 * before anything is written (DataRoomError when it does not fit, and then
 * nothing is); each is written only where no text is kept yet; anything
 * that comes back otherwise takes away what this call wrote, gives its room
 * back and throws. Never a partial import left behind.
 */
export async function saveNewBodies(courseId: string, bodies: { lessonId: string; text: string }[], room: DataStore): Promise<void> {
  if (!COURSE_ID_PATTERN.test(courseId)) throw new Error("not a course id");
  const ids = new Set<string>();
  for (const { lessonId, text } of bodies) {
    if (!ITEM_ID_PATTERN.test(lessonId) || ids.has(lessonId)) throw new Error("not a new lesson's text");
    if (typeof text !== "string" || !text || cleanBody(text) !== text) throw new Error("not a lesson text as the editor keeps it");
    ids.add(lessonId);
  }
  if (!bodies.length) return;
  if (!isRedisConfigured()) throw new Error("lesson texts cannot be written here");
  const bytes = bodies.reduce((sum, { text }) => sum + bodyBytes(text), 0);
  await needData(room, [{ slot: BODIES_SLOT(courseId), bytes }]);
  let replies: unknown[] | null = null;
  try {
    replies = repliesFor(await redisPipeline(bodies.map(({ lessonId, text }) => ["SET", bodyKey(courseId, lessonId), text, "NX"])), bodies.length);
  } catch {
    replies = null;
  }
  if (replies && replies.every((reply) => reply === "OK")) return;
  // Taking back: only what this call is known to have written goes, each by an atomic compare-and-delete of its exact text,
  // and only the room of what is known to be gone (or never written) comes back. An unknown reply is never taken as this
  // call's own (the key may hold another writer's equal text), so nothing of it is deleted and its room stays counted:
  // more, never less (Revisor 1 and Codex L on #3821).
  const gone: { lessonId: string; text: string }[] = [];
  const mine: { lessonId: string; text: string }[] = [];
  bodies.forEach((body, i) => {
    const reply = replies?.[i];
    if (replies && reply === null) gone.push(body); // NX refused: another text is kept there, and this one was never written.
    else if (reply === "OK") mine.push(body);
  });
  if (mine.length) {
    let deleted: unknown[] | null = null;
    try {
      deleted = repliesFor(await redisPipeline(mine.map((body) => ["EVAL", DELETE_IF_SAME, 1, bodyKey(courseId, body.lessonId), body.text])), mine.length);
    } catch {
      deleted = null;
    }
    // 1: this call's text, deleted. 0: replaced or deleted by someone else since; theirs, so left and still counted.
    mine.forEach((body, i) => {
      if (deleted?.[i] === 1) gone.push(body);
    });
  }
  const back = gone.reduce((sum, { text }) => sum + bodyBytes(text), 0);
  if (back > 0) await giveData(room, [{ slot: BODIES_SLOT(courseId), bytes: back }]);
  throw new UnknownReplyError("an imported course's lesson texts");
}

/** Takes a course's records away, and gives back their room. Its files are the caller's to delete. */
export async function dropCourse(course: Course, room: DataStore): Promise<void> {
  const keys = [courseKey(course.id), ...lessonsInOrder(course).map(({ lesson }) => bodyKey(course.id, lesson.id))];
  await redisPipeline(keys.map((key) => ["DEL", key]));
  await giveData(room, [{ slot: OUTLINE_SLOT(course.id), bytes: 0, set: true }, { slot: BODIES_SLOT(course.id), bytes: 0, set: true }]);
}

export async function dropBody(courseId: string, lessonId: string, room: DataStore): Promise<void> {
  const before = await readBody(courseId, lessonId);
  await redisPipeline([["DEL", bodyKey(courseId, lessonId)]]);
  if (before) await giveData(room, [{ slot: BODIES_SLOT(courseId), bytes: bodyBytes(before) }]);
}

/** Lesson text, cleaned the same way wherever it is saved from. */
export function cleanBody(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_BODY_LENGTH);
}
