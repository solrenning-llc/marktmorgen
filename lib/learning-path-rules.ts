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

/** The most paths one store may keep (249 [ST2], unit 2). */
export const MAX_PATHS = 12;

const PATH_ID = /^[a-z0-9]{8}$/;

/** A path as a store keeps it: the creator's path with an id of its own, kept for good across saves. */
export type StoredPath = LearningPath & { id: string };

export type PathsProblem = PathProblem | "too_many" | "list";

/** A new path's id. */
export function newPathId(random: () => number = Math.random): string {
  const letters = "abcdefghijkmnpqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < 8; i += 1) id += letters[Math.floor(random() * letters.length) % letters.length];
  return id;
}

/**
 * Every path of a store as the studio sends them, all at once, in the order
 * shown: each read by readPathInput against the store's own courses. Refused
 * as a whole, saying which path and why, rather than cut down, so the studio
 * never says "saved" about something that was not kept. An existing path
 * keeps its id; a new one (no id, or one this store does not have) is given
 * one no path of the current list has. A deleted path's id is not kept, so
 * whatever is later keyed by a path's id must not outlive its path.
 */
export function readPathsInput(
  raw: unknown,
  current: readonly StoredPath[],
  storeCourses: ReadonlySet<string>,
  random: () => number = Math.random,
): { ok: true; paths: StoredPath[] } | { ok: false; problem: PathsProblem; index: number } {
  if (!Array.isArray(raw)) return { ok: false, problem: "list", index: -1 };
  if (raw.length > MAX_PATHS) return { ok: false, problem: "too_many", index: MAX_PATHS };
  const out: StoredPath[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const read = readPathInput(raw[index], storeCourses);
    if (!read.ok) return { ok: false, problem: read.problem, index };
    const entry = raw[index] as Record<string, unknown>;
    const asked = typeof entry.id === "string" ? entry.id : "";
    let id = current.some((p) => p.id === asked) && !out.some((p) => p.id === asked) ? asked : "";
    for (let tries = 0; !id && tries < 20; tries += 1) {
      const fresh = newPathId(random);
      // Only an id that reads back (review, LEVE 2): an odd random never gives one the stored list would refuse.
      if (PATH_ID.test(fresh) && !out.some((p) => p.id === fresh) && !current.some((p) => p.id === fresh)) id = fresh;
    }
    if (!id) return { ok: false, problem: "list", index };
    out.push({ id, ...read.path });
  }
  return { ok: true, paths: out };
}

/**
 * A store's kept list, read whole: null when any of it does not read (not
 * JSON, not a list, more than MAX_PATHS, a path whose id, name, courses or
 * order does not read, or an id twice). Never a shorter list: a path that
 * cannot be read is unknown, and the caller says so (rule 24). The courses
 * are read by their form only: whether the store still has each is for the
 * reader that shows the path.
 */
export function parseStoredPaths(raw: string): StoredPath[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length > MAX_PATHS) return null;
  const out: StoredPath[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !PATH_ID.test(e.id) || out.some((p) => p.id === e.id)) return null;
    const courses = Array.isArray(e.courses) ? e.courses : [];
    const read = readPathInput(e, new Set(courses.filter((c): c is string => typeof c === "string")));
    if (!read.ok || read.path.name !== e.name) return null;
    out.push({ id: e.id, ...read.path });
  }
  return out;
}
