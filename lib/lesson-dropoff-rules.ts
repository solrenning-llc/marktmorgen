/**
 * Where students stop in a course (96 [D2-LESSON-DROPOFF], unit 1; added
 * 10 November 2026): the rules, before anything is read. Pure and
 * browser-safe: no Redis, no setting, no secret.
 *
 * From what the course already keeps for each student who opened it (the
 * lessons they marked done and when they were last seen, lib/learn.ts), it
 * says for each lesson how many marked it done, out of everyone who opened
 * the course, and where the students who stopped stopped:
 *
 *   - finished: every lesson of the course marked done, in any order;
 *   - stopped: not finished, and not seen for more than STOPPED_AFTER_DAYS;
 *     they stopped at the first lesson, in the course's order, they did not
 *     mark done;
 *   - still going: everyone else. Someone seen this week is never "stopped".
 *
 * Lessons no longer in the course are not counted; a lesson added later is
 * done by nobody yet. A student whose record cannot be read is counted apart
 * as unread, never as anything else. The lesson where most stopped is named
 * only when at least MIN_STOPPED_FOR_PATTERN stopped, and the words say
 * where, never why: a count of where people stopped is not a reason.
 *
 * Next units: the reading on the course's studio page (lib/learn.ts,
 * studentsOf, which already reads each student's lessons) and refunds beside
 * each lesson, from what the store's own sales say.
 */

/** A student not seen for longer than this, who has not finished, counts as stopped. */
export const STOPPED_AFTER_DAYS = 14;
/** The fewest stopped students for which the lesson where most stopped is named. */
export const MIN_STOPPED_FOR_PATTERN = 5;

const DAY_MS = 86_400_000;

export type DropoffLesson = { id: string; title: string };
/** What the course keeps of one student: the ids of the lessons marked done, and when they were last seen (ms). */
export type DropoffStudent = { done: readonly string[]; lastSeen: number };

export type LessonRow = {
  id: string;
  title: string;
  /** Students who marked this lesson done. */
  done: number;
  /** Out of: every student read. */
  of: number;
  /** Stopped students whose first lesson not done is this one. */
  stoppedHere: number;
};

export type DropoffMap = {
  lessons: LessonRow[];
  students: number;
  finished: number;
  going: number;
  stopped: number;
  /** Records that could not be read: not counted anywhere else. */
  unread: number;
  /** The lesson where most stopped, the earliest on a tie; null below MIN_STOPPED_FOR_PATTERN stopped. */
  most: string | null;
  /** How many other lessons as many stopped at as at `most`. */
  tiedWith: number;
};

/**
 * A student as kept, with a time that can be a real one: a whole number of milliseconds after 1970. A time ahead of
 * now is still read (another server's clock), and counts as still going.
 */
function readable(student: unknown): student is DropoffStudent {
  if (!student || typeof student !== "object") return false;
  const { done, lastSeen } = student as { done?: unknown; lastSeen?: unknown };
  return Array.isArray(done) && done.every((id) => typeof id === "string") && typeof lastSeen === "number" && Number.isSafeInteger(lastSeen) && lastSeen > 0;
}

/** Where the students of a course stop, lesson by lesson, from what is kept of each. */
export function lessonDropoff(lessons: readonly DropoffLesson[], students: readonly DropoffStudent[], now: number): DropoffMap {
  // An unreadable clock is refused (rule 24): read as is, it made every student "still going".
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError("lessonDropoff needs the time now as a whole number of milliseconds");
  const rows: LessonRow[] = lessons.map((lesson) => ({ id: lesson.id, title: lesson.title, done: 0, of: 0, stoppedHere: 0 }));
  const index = new Map(rows.map((row, i) => [row.id, i]));
  let read = 0;
  let unread = 0;
  let finished = 0;
  let going = 0;
  let stopped = 0;
  for (const student of students) {
    if (!readable(student)) {
      unread += 1;
      continue;
    }
    read += 1;
    const done = new Set(student.done.filter((id) => index.has(id)));
    for (const id of done) rows[index.get(id)!].done += 1;
    if (!rows.length) {
      going += 1;
      continue;
    }
    const first = rows.findIndex((row) => !done.has(row.id));
    if (first === -1) {
      finished += 1;
      continue;
    }
    if (now - student.lastSeen > STOPPED_AFTER_DAYS * DAY_MS) {
      stopped += 1;
      rows[first].stoppedHere += 1;
    } else {
      going += 1;
    }
  }
  for (const row of rows) row.of = read;
  let most: string | null = null;
  let tiedWith = 0;
  if (stopped >= MIN_STOPPED_FOR_PATTERN) {
    const top = Math.max(...rows.map((row) => row.stoppedHere));
    const atTop = rows.filter((row) => row.stoppedHere === top);
    most = atTop[0].id;
    tiedWith = atTop.length - 1;
  }
  return { lessons: rows, students: read, finished, going, stopped, unread, most, tiedWith };
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The map in plain words: a line for each lesson, a summary, the lesson where most stopped, and the unread. */
export function dropoffLines(map: DropoffMap): { lessons: string[]; summary: string; most: string; unread: string } {
  const lessons = map.lessons.map((row) => {
    const base = `${row.title}: ${row.done.toLocaleString("en-US")} of ${plural(row.of, "student", "students")} marked it done.`;
    return row.stoppedHere > 0 ? `${base} ${row.stoppedHere.toLocaleString("en-US")} stopped here.` : base;
  });
  const summary = `Of ${plural(map.students, "student", "students")}, ${map.finished.toLocaleString("en-US")} finished, ${map.going.toLocaleString("en-US")} ${map.going === 1 ? "is" : "are"} still going and ${map.stopped.toLocaleString("en-US")} stopped (not seen for ${STOPPED_AFTER_DAYS} days).`;
  const named = map.most === null ? undefined : map.lessons.find((row) => row.id === map.most);
  const most = named
    ? `Students stopped most often at "${named.title}"${map.tiedWith > 0 ? `, as often as at ${plural(map.tiedWith, "other lesson", "other lessons")}` : ""}. This shows where they stopped, not why.`
    : "";
  const unread = map.unread > 0 ? `${plural(map.unread, "student", "students")} could not be read, so ${map.unread === 1 ? "is" : "are"} not counted here.` : "";
  return { lessons, summary, most, unread };
}
