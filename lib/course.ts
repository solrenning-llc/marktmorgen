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
import { courseAccessExpiryState } from "@/lib/course-access-expiry-rules";

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
  /**
   * When access to the course ends, in seconds (24 [E7]), or absent for no end, as for every course before it.
   *
   * Fairness: the date reaches only a buyer who was shown it before paying. The course's own sales page and course
   * page say it and send it with the buy form; the checkout refuses when it is no longer the date shown, and stamps
   * the one shown on the Stripe session (`metadata[access_end]`, lib/course-access-end.ts). The learner's gate
   * (lib/learn.ts courseAccess) then holds an end only for a stamped purchase: every other way in (the storefront
   * card, the cart, a bundle, a box ticked at checkout, a gift, a pre-order, a group place, an import, a community
   * level) carries no stamp and has no end, and with several purchases the most generous one counts.
   *
   * A stamped buyer's end is the later of their stamp and this date (stampedAccessEnd): moving the date later moves it
   * for them too, taking it off removes their end, and it can never move earlier than a date already set
   * ("access-end" in editCourse). A membership course never takes one: members keep access while they pay.
   */
  accessEndsAt?: number;
  /**
   * Ends already reached by stamped buyers when the date was taken off (Codex Cloud 1 on #3445): `at` is the date the
   * course had then, and every stamped buyer who bought at or before `before` keeps at least it, so taking the date off
   * and setting an earlier one (the studio's way to end sooner for new buyers) never shortens an end a buyer already
   * had. "unknown": a list that did not read, so an end is a check not made for a stamped buyer (rule 24).
   */
  accessEndsKept?: KeptEnd[] | "unknown";
};

/** An end reached by the stamped buyers who bought at or before `before` (Course.accessEndsKept). */
export type KeptEnd = { at: number; before: number };

/**
 * The most kept ends a course holds. Each new one drops those it covers (an end no later, for fewer buyers); past
 * this, the two oldest merge into the later end for the later group, which only ever gives a buyer more time.
 */
export const MAX_KEPT_ENDS = 12;

/** The list with one more kept end, taken when the date comes off at `before`. */
export function keepEnd(kept: KeptEnd[], next: KeptEnd): KeptEnd[] {
  const out = [...kept.filter((k) => k.at > next.at && k.before <= next.before), next].sort((a, b) => a.before - b.before);
  while (out.length > MAX_KEPT_ENDS) {
    const [first, second] = out;
    out.splice(0, 2, { at: Math.max(first.at, second.at), before: second.before });
  }
  return out;
}

/** A stored list of kept ends: absent is none, any other shape than the one written is "unknown" (rule 24). */
function readKeptEnds(raw: unknown): KeptEnd[] | "unknown" | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_KEPT_ENDS) return "unknown";
  const kept: KeptEnd[] = [];
  for (const item of raw) {
    const entry = item as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object" || Object.keys(entry).length !== 2) return "unknown";
    if (!Number.isSafeInteger(entry.at) || (entry.at as number) <= 0 || !Number.isSafeInteger(entry.before) || (entry.before as number) <= 0) return "unknown";
    kept.push({ at: entry.at as number, before: entry.before as number });
  }
  return kept.length ? kept : undefined;
}

/** The furthest ahead an access end may be set: ten years. */
export const MAX_ACCESS_END_SECONDS = 3_650 * 86_400;

/** The course's end date while it is still ahead, or null (the studio says a passed one as passed). */
export function accessEndAhead(course: Pick<Course, "accessEndsAt">, nowSeconds = Date.now() / 1000): number | null {
  return course.accessEndsAt !== undefined && course.accessEndsAt > Math.floor(nowSeconds) ? course.accessEndsAt : null;
}

/**
 * How long Stripe keeps a checkout open at most: 24 hours, its maximum (and default) session lifetime. A checkout
 * opened before the end can be paid until then, after the end has passed (C2's M-A on #3445), so a stamp counts only
 * on a session created at least this long before it (lib/learn.ts), and the store stops saying the date this long
 * before it (accessEndForSale): whoever buys in that last day keeps the course with no end.
 */
export const CHECKOUT_OPEN_SECONDS = 24 * 3600;

/**
 * The end date to say, and stamp, to somebody who has not bought yet, or null: only one more than a checkout's
 * lifetime ahead (CHECKOUT_OPEN_SECONDS), so nobody is charged after the end for access the date already closed.
 */
export function accessEndForSale(course: Pick<Course, "accessEndsAt">, nowSeconds = Date.now() / 1000): number | null {
  return course.accessEndsAt !== undefined && course.accessEndsAt - Math.floor(nowSeconds) > CHECKOUT_OPEN_SECONDS ? course.accessEndsAt : null;
}

/** Whether a purchase made at `createdSeconds` (unknown: null) is held to the end it was stamped with. */
export function stampHolds(stamp: number, createdSeconds: number | null): boolean {
  return createdSeconds !== null && Number.isSafeInteger(createdSeconds) && createdSeconds <= stamp - CHECKOUT_OPEN_SECONDS;
}

/**
 * A stamped purchase's end, in seconds, or null for none: the latest of the end its buyer was shown (`stamp`), the
 * course's date now, so moving the date later reaches them, and every end they had already reached when the date was
 * taken off (accessEndsKept, for a purchase made at `boughtAt` or before; not known, every one counts); null while
 * the creator has the date off. "unknown" when the kept ends did not read.
 */
export function stampedAccessEnd(course: Pick<Course, "accessEndsAt" | "accessEndsKept">, stamp: number, boughtAt: number | null): number | null | "unknown" {
  if (course.accessEndsAt === undefined) return null;
  if (course.accessEndsKept === "unknown") return "unknown";
  let end = Math.max(stamp, course.accessEndsAt);
  for (const kept of course.accessEndsKept ?? []) {
    if (boughtAt === null || !Number.isSafeInteger(boughtAt) || boughtAt <= kept.before) end = Math.max(end, kept.at);
  }
  return end;
}

/**
 * Whether a learner whose purchase carries `stamp` (null: no end was shown, so none) may still take the course at
 * `nowSeconds`: "open", "ended" once their end has passed (lib/course-access-expiry-rules.ts), or "unknown" when a
 * time does not read, which the gate says as a check it could not make, never as ended and never as open.
 */
export function accessEndState(
  course: Pick<Course, "accessEndsAt" | "accessEndsKept">,
  stamp: number | null,
  nowSeconds: number,
  boughtAt: number | null,
): "open" | "ended" | "unknown" {
  if (!Number.isFinite(nowSeconds) || (stamp !== null && !Number.isSafeInteger(stamp))) return "unknown";
  const end = stamp === null ? null : stampedAccessEnd(course, stamp, boughtAt);
  if (end === "unknown") return "unknown";
  const state = courseAccessExpiryState(end, Math.floor(nowSeconds));
  return state === "expired" ? "ended" : state === "invalid" ? "unknown" : "open";
}

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
    // A whole number of seconds after 1970, or no end (24 [E7]): a value of any other shape is no end, the side that
    // never takes a course away from anybody (lib/learn.ts courseAccess holds an end only for a stamped purchase).
    const ends = Number.isSafeInteger(value.accessEndsAt) && (value.accessEndsAt as number) > 0 ? { accessEndsAt: value.accessEndsAt as number } : {};
    const kept = readKeptEnds(value.accessEndsKept);
    return { id: value.id, modules, certificate: value.certificate === true, ...(months ? { certificateMonths: months } : {}), startsAt, ...(value.stampVideo === true ? { stampVideo: true } : {}), ...(shelf.length ? { shelf } : {}), ...ends, ...(kept ? { accessEndsKept: kept } : {}) };
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
  /**
   * When access ends (24 [E7]): a moment in seconds after `now` and at most ten years ahead, or null to take it off.
   * `membership`: the course is sold as a membership, which never takes an end (members keep it while they pay).
   */
  | { op: "access-end"; at: unknown; now: number; membership: boolean }
  /** Several modules at once, each with its lessons by title: an outline taken from the writing help (lib/ai.ts). */
  | { op: "outline"; modules: { title: unknown; lessons: unknown[] }[] };

export type EditResult =
  | { ok: true; course: Course; removed: ProductFile[]; addedId?: string }
  | { ok: false; reason: "unknown" | "too_many" | "not_empty" | "drip" | "files" | "video_type" | "start" | "months" | "access_end" | "access_end_earlier" | "access_end_membership" };

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
    case "access-end": {
      const now = Math.floor(edit.now);
      if (edit.at === null) {
        const rest = { ...course };
        delete rest.accessEndsAt;
        // The end every stamped buyer has now is kept for them (Codex Cloud 1 on #3445), so a date set again, even an
        // earlier one for new buyers, never shortens it. A list that did not read stays "unknown".
        if (course.accessEndsAt !== undefined && course.accessEndsKept !== "unknown") {
          rest.accessEndsKept = keepEnd(course.accessEndsKept ?? [], { at: course.accessEndsAt, before: now });
        }
        return { ok: true, course: rest, removed: [] };
      }
      // A membership is open while it is paid: an end date would lock out a member who is still being charged.
      if (edit.membership) return { ok: false, reason: "access_end_membership" };
      if (typeof edit.at !== "number" || !Number.isSafeInteger(edit.at) || edit.at <= now || edit.at > now + MAX_ACCESS_END_SECONDS) {
        return { ok: false, reason: "access_end" };
      }
      // Never earlier than a date already set: the creator's own promise, which the studio keeps simple to read.
      // Buyers already stamped keep the later of their stamp and this date either way (stampedAccessEnd).
      if (course.accessEndsAt !== undefined && edit.at < course.accessEndsAt) return { ok: false, reason: "access_end_earlier" };
      return { ok: true, course: { ...course, accessEndsAt: edit.at }, removed: [] };
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
