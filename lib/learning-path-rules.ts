/**
 * A learning path (249 [ST2], unit 1: the rules only; nothing keeps, sells
 * or shows a path yet): several of a store's own courses in the order the
 * creator sets, with the student's progress through them and a certificate
 * for the whole path once every course is finished.
 *
 *   - 2 to MAX_PATH_COURSES courses of the store, each once, and a name.
 *   - "sequence": each course opens once the one before it is finished;
 *     "free": every course the student has is open, in the order shown.
 *   - A course the student does not have is never open, whatever else is
 *     true; it says it is not included.
 *   - Unknown is never open and never finished (rule 24): when what the
 *     student has, or what they finished, could not be read, every course
 *     is "unknown", the path is not complete, and the student is told so.
 *
 * The courses' own access, drip, cohorts, quizzes and certificates stay
 * what they are; a path only orders them. Pure: no storage, no network.
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
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.replace(/\s+/g, " ").trim() : "";
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
  | { id: string; state: "locked"; after: string };

export type PathProgress = { courses: CourseState[]; finished: number | null; total: number; complete: boolean };

/**
 * Where a student is on a path: `has` the courses they may open, `finished`
 * the courses they finished; either null when it could not be read.
 */
export function pathProgress(path: LearningPath, student: { has: ReadonlySet<string> | null; finished: ReadonlySet<string> | null }): PathProgress {
  const total = path.courses.length;
  const { has, finished } = student;
  if (!has || !finished) return { courses: path.courses.map((id) => ({ id, state: "unknown" as const })), finished: null, total, complete: false };
  const courses: CourseState[] = [];
  path.courses.forEach((id, i) => {
    const before = courses[i - 1];
    // In sequence, a course opens, or counts as finished, only once the path's own course before it is done.
    const reached = path.order === "free" || i === 0 || before.state === "done";
    if (!has.has(id)) courses.push({ id, state: "not_owned" });
    else if (!reached) courses.push({ id, state: "locked", after: path.courses[i - 1] });
    else courses.push({ id, state: finished.has(id) ? "done" : "open" });
  });
  // A course counts as finished only where the path lets it be (in sequence, in order).
  const done = courses.filter((c) => c.state === "done").length;
  return { courses, finished: done, total, complete: done === total };
}

/** What the student reads on the path's page, line by line. */
export function pathWords(path: LearningPath, progress: PathProgress, titles: ReadonlyMap<string, string>): string[] {
  if (progress.finished === null) return ["Your progress could not be read just now. Nothing here is locked or finished because of it; try again in a moment."];
  const title = (id: string) => titles.get(id) ?? "A course";
  const started = progress.finished > 0;
  const lines = progress.courses.map((c) => {
    if (c.state === "done") return `${title(c.id)}: finished.`;
    if (c.state === "locked") return `${title(c.id)}: opens when you finish ${title(c.after)}.`;
    if (c.state === "not_owned") return `${title(c.id)}: not included in what you have.`;
    return `${title(c.id)}: ${started || path.order === "free" ? "open now." : "start here."}`;
  });
  lines.push(progress.complete ? `All ${progress.total} courses finished. Your certificate for the path is ready.` : `${progress.finished} of ${progress.total} courses finished.`);
  return lines;
}
