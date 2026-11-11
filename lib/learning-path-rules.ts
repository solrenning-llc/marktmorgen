/**
 * A learning path (249 [ST2], unit 1: the rules only; nothing keeps, sells
 * or shows a path yet): several of a store's own courses in the order the
 * creator sets, with the student's progress through them.
 *
 *   - 2 to MAX_PATH_COURSES courses of the store, each once, and a name.
 *   - "sequence": the path suggests one course at a time. A course the
 *     student has is "waiting" while a course before it in the path that
 *     they also have is not finished; courses they do not have are passed
 *     over, so a course they paid for never waits on one they cannot take
 *     (review of #3674). "free": every course the student has is open.
 *   - "waiting" is the path's suggested order only. It never takes away or
 *     shortens access to a course the student has: the course's own access,
 *     drip, cohorts, quizzes and certificates stay what they are.
 *   - A finished course is "done", in whatever order it was finished.
 *   - A course the student does not have is never open or done; it says it
 *     is not included.
 *   - Unknown is never open and never finished (rule 24): when what the
 *     student has, or what they finished, could not be read (or is not a
 *     set), or the path is not 2 to MAX_PATH_COURSES distinct courses, every
 *     course is "unknown" and the path is not complete.
 *
 * Pure: no storage, no network.
 */

export const MIN_PATH_COURSES = 2;
export const MAX_PATH_COURSES = 10;
export const MAX_PATH_NAME = 80;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export type PathOrder = "sequence" | "free";
export type LearningPath = { name: string; courses: string[]; order: PathOrder };
export type PathProblem = "name" | "courses" | "order";

/** A path as the creator set it, checked against the store's own courses. */
export function readPathInput(raw: unknown, storeCourses: ReadonlySet<string>): { ok: true; path: LearningPath } | { ok: false; problem: PathProblem } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "name" };
  let value: { name: unknown; courses: unknown; order: unknown };
  try {
    const record = raw as Record<string, unknown>;
    value = { name: record.name, courses: Array.isArray(record.courses) ? [...record.courses] : record.courses, order: record.order };
  } catch {
    return { ok: false, problem: "name" };
  }
  // Control and invisible characters (format, such as zero-width) are taken out before the name is measured.
  const name = typeof value.name === "string" ? value.name.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > MAX_PATH_NAME) return { ok: false, problem: "name" };
  const courses = value.courses;
  if (
    !Array.isArray(courses) || courses.length < MIN_PATH_COURSES || courses.length > MAX_PATH_COURSES ||
    !courses.every((id) => typeof id === "string" && ID.test(id) && storeCourses.has(id)) || new Set(courses).size !== courses.length
  ) {
    return { ok: false, problem: "courses" };
  }
  if (value.order !== "sequence" && value.order !== "free") return { ok: false, problem: "order" };
  return { ok: true, path: { name, courses: [...courses] as string[], order: value.order } };
}

export type CourseState =
  | { id: string; state: "done" | "open" | "not_owned" | "unknown" }
  /** Suggested after `after`, a course of the path before it that the student has and has not finished. Never a lock. */
  | { id: string; state: "waiting"; after: string };

export type PathProgress = { courses: CourseState[]; finished: number | null; total: number; complete: boolean };

const isSet = (value: unknown): value is ReadonlySet<string> => value instanceof Set;

/**
 * Where a student is on a path: `has` the courses they may open, `finished`
 * the courses they finished; either null when it could not be read.
 */
export function pathProgress(path: LearningPath, student: { has: ReadonlySet<string> | null; finished: ReadonlySet<string> | null }): PathProgress {
  const ids = Array.isArray(path.courses) ? path.courses : [];
  const total = ids.length;
  const { has, finished } = student;
  const shaped = total >= MIN_PATH_COURSES && total <= MAX_PATH_COURSES && new Set(ids).size === total;
  if (!shaped || !isSet(has) || !isSet(finished)) return { courses: ids.map((id) => ({ id, state: "unknown" as const })), finished: null, total, complete: false };
  const courses: CourseState[] = [];
  // In sequence, the first course of the path that the student has and has not finished: every later one waits on it.
  let pending: string | null = null;
  for (const id of ids) {
    if (!has.has(id)) {
      courses.push({ id, state: "not_owned" });
      continue;
    }
    if (finished.has(id)) {
      courses.push({ id, state: "done" });
      continue;
    }
    if (path.order === "sequence" && pending !== null) courses.push({ id, state: "waiting", after: pending });
    else courses.push({ id, state: "open" });
    if (pending === null) pending = id;
  }
  const done = courses.filter((c) => c.state === "done").length;
  return { courses, finished: done, total, complete: done === total };
}

/** What the student reads on the path's page, line by line. */
export function pathWords(path: LearningPath, progress: PathProgress, titles: ReadonlyMap<string, string>): string[] {
  if (progress.finished === null) return ["Your progress could not be read just now. Nothing here is marked finished because of it; try again in a moment."];
  const title = (id: string) => titles.get(id) ?? "A course";
  const started = progress.finished > 0;
  const lines = progress.courses.map((c) => {
    if (c.state === "done") return `${title(c.id)}: finished.`;
    if (c.state === "waiting") return `${title(c.id)}: next after ${title(c.after)}. You can open it any time.`;
    if (c.state === "not_owned") return `${title(c.id)}: not included in what you have.`;
    return `${title(c.id)}: ${started || path.order === "free" ? "open now." : "start here."}`;
  });
  lines.push(progress.complete ? `All ${progress.total} courses finished.` : `${progress.finished} of ${progress.total} courses finished.`);
  return lines;
}
