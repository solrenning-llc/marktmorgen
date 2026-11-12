/**
 * The rules of acting on many of a course's students at once (279 [H3-4],
 * unit 1), shared by the studio's screen and the server
 * (lib/student-bulk.ts, app/api/store/students/route.ts). Browser-safe.
 *
 * What it does: filters one page of a course's students by progress, access
 * and label; takes access away from those selected or gives it back to those
 * who were taken off; and says, person by person, what happened. Labels on
 * the selection go through the labels route that already exists
 * (lib/bulk-labels.ts), and the file of the selection is made in the browser
 * from what the page already shows. Refunds are never in bulk: they stay one
 * at a time, from the order.
 */
import { count, labelKey } from "@/lib/bulk-label-rules";
import { csvLine } from "@/lib/csv";

/** Students read for one page of the list: one bounded read, paid for first (listUnits, labelUnits). */
export const STUDENTS_PER_PAGE = 100;
/** The most people one change of access takes; past it the change is refused, never cut. */
export const MAX_STUDENT_ACTION = 500;
/** People whose access is read in one command. */
export const ACCESS_READ_BATCH = 100;
/** Writes of access sent at the same time. */
export const ACCESS_WRITES_AT_ONCE = 20;
/** The longest address a change takes (lib/auth.ts, MAX_EMAIL_LENGTH). */
const MAX_ADDRESS = 254;
/** The longest body a change sends: every address at its longest, quoted and separated, and the rest of the request. */
export const MAX_STUDENT_BODY_BYTES = 1_000 + MAX_STUDENT_ACTION * (MAX_ADDRESS * 6 + 3);

/** Commands a studio request is priced at (tests/plan-cost-registry.ts, UNIT_COST.studio). */
export const STUDIO_REQUEST_COMMANDS = 20;
/** Commands one person's change of access sends: setBlocked's own two (lib/learn.ts). */
export const ACCESS_WRITE_COMMANDS = 2;

const people = (n: number) => Math.max(0, Math.floor(n));
/** Commands reading the access of `n` people sends: a command pair (HMGET, SMISMEMBER) per ACCESS_READ_BATCH. */
const readCommands = (n: number) => 2 * Math.ceil(people(n) / ACCESS_READ_BATCH);

/**
 * Studio requests taken before the access of `n` people is read, on a review
 * and before a change: the read's own commands, twenty to a request. At least
 * one.
 */
export function accessReadUnits(n: number): number {
  return Math.max(1, Math.ceil(readCommands(n) / STUDIO_REQUEST_COMMANDS));
}
/**
 * Studio requests a change of access takes after its read and before it
 * writes: each person's write (ACCESS_WRITE_COMMANDS) and the read-back of
 * them all, twenty commands to a request. At least one. With the read's own
 * (accessReadUnits), the whole change is paid for before each part of it.
 */
export function accessUnits(n: number): number {
  return Math.max(1, Math.ceil((ACCESS_WRITE_COMMANDS * people(n) + readCommands(n)) / STUDIO_REQUEST_COMMANDS));
}
/** Studio requests taken before a page's rows are read: one command a row (what each marked done), twenty to a request. */
export function listUnits(rows: number): number {
  return Math.ceil(Math.max(0, Math.floor(rows)) / 20);
}
/**
 * Studio requests taken before the labels of a page's students are read: a
 * contact's record is up to two kilobytes, and a studio request is priced at
 * fifty kilobytes read, so twenty-five records to a request.
 */
export function labelUnits(rows: number): number {
  return Math.ceil(Math.max(0, Math.floor(rows)) / 25);
}

export type Progress = "none" | "started" | "finished";

/** Where a student is: not started, started, or every lesson marked done (a course with no lessons is never finished). */
export function progressOf(done: number, lessons: number): Progress {
  if (done <= 0) return "none";
  return lessons > 0 && done >= lessons ? "finished" : "started";
}

export const PROGRESS_WORDS: Record<Progress, string> = { none: "Not started", started: "Started, not finished", finished: "Finished" };

export type AccessFilter = "any" | "active" | "removed";
export type StudentFilters = { progress: Progress | "any"; access: AccessFilter; label: string };

const one = (value: unknown) => (typeof value === "string" ? value : "");

/** The filters from the page's address; anything that is not one of them is no filter. */
export function readFilters(query: Record<string, unknown>): StudentFilters {
  const progress = one(query.progress);
  const access = one(query.access);
  return {
    progress: progress === "none" || progress === "started" || progress === "finished" ? progress : "any",
    access: access === "active" || access === "removed" ? access : "any",
    label: one(query.label).replace(/\s+/gu, " ").trim().slice(0, 80),
  };
}

/** One student as the list shows them. `labels` null: their contact could not be read, so not known. */
export type StudentLine = { email: string; since: number; lastSeen: number; done: number; removed: boolean; labels: string[] | null };

/**
 * The students that match the filters. With a label asked for, a student
 * whose labels could not be read is left out and counted (`labelsUnknown`),
 * so the screen says so: never guessed as having it or not.
 */
export function filterStudents(lines: readonly StudentLine[], lessons: number, filters: StudentFilters): { shown: StudentLine[]; labelsUnknown: number } {
  const wanted = filters.label ? labelKey(filters.label) : "";
  let labelsUnknown = 0;
  const shown = lines.filter((line) => {
    if (filters.progress !== "any" && progressOf(line.done, lessons) !== filters.progress) return false;
    if (filters.access === "active" && line.removed) return false;
    if (filters.access === "removed" && !line.removed) return false;
    if (!wanted) return true;
    if (line.labels === null) {
      labelsUnknown += 1;
      return false;
    }
    return line.labels.some((label) => labelKey(label) === wanted);
  });
  return { shown, labelsUnknown };
}

/** revoke: take access away; grant: give it back to a student who was taken off. */
export type AccessChange = "revoke" | "grant";
export const oppositeAccess = (change: AccessChange): AccessChange => (change === "revoke" ? "grant" : "revoke");

export type AccessRefusal = "change" | "none" | "many" | "product" | "expect";

export const ACCESS_REFUSALS: Record<AccessRefusal, string> = {
  change: "Choose whether to remove access or give it back.",
  none: "Select at least one student first.",
  many: `Select at most ${MAX_STUDENT_ACTION.toLocaleString("en-US")} students for one change.`,
  product: "Open one of your courses first.",
  expect: "Review the change first, then confirm it.",
};

/** The sentence for a store whose data room is full: the labels page's own (components/bulk-labels.tsx). */
export const STORE_FULL_WORDS = "Your store has no room left for more records. Delete some you no longer need first.";

const NOT_DONE_WORDS = "That did not work. Nothing was changed. Try again in a moment.";

/**
 * How the students screen reads one answer: a done change ("ok", only `ok: true`); a count that moved since the
 * review ("moved", only a 409 that says "changed" and carries its new review); otherwise a refusal with the words to
 * show. So a 409 of any other kind (the labels route's "data_full" for a full store) is said, never left silent.
 */
export function sentOutcome(status: number, answer: Record<string, unknown>): { kind: "ok" } | { kind: "moved" } | { kind: "refused"; words: string } {
  if (answer.ok === true) return { kind: "ok" };
  if (status === 409 && answer.error === "changed" && typeof answer.review === "object" && answer.review !== null) return { kind: "moved" };
  if (typeof answer.message === "string" && answer.message) return { kind: "refused", words: answer.message };
  if (answer.error === "data_full") return { kind: "refused", words: STORE_FULL_WORDS };
  return { kind: "refused", words: NOT_DONE_WORDS };
}

/** What a change would do, read now, with nothing written. `unread`: people whose access could not be read; they are left as they are. */
export type AccessReview = { changes: number; already: number; notStudent: number; unread: number };

/**
 * What a change did, person by person.
 *   changed     written, and read back as asked
 *   already     already as asked, left as they are
 *   notStudent  not a student of this course
 *   unread      their access could not be read, so nothing was written
 *   unknown     written, but it could not be read back: it may or may not have changed
 *   failed      the write went wrong and they are read back as before
 */
export type AccessDone = { asked: number; changed: string[]; already: string[]; notStudent: string[]; unread: string[]; unknown: string[]; failed: string[] };

/** The lines a review shows before the creator confirms. */
export function accessReviewLines(review: AccessReview, change: AccessChange): string[] {
  return [
    `${count(review.changes, "student", "students")} will ${change === "revoke" ? "lose access to this course" : "get access to this course back"}.`,
    review.already ? `${count(review.already, "student", "students")} ${change === "revoke" ? "already have no access" : "already have access"}: left as they are.` : "",
    review.notStudent ? `${count(review.notStudent, "address is", "addresses are")} not a student of this course: nothing changes for them.` : "",
    review.unread ? `${count(review.unread, "student's access", "students' access")} could not be read just now: left as ${review.unread === 1 ? "it is" : "they are"}.` : "",
    "No email is sent and nothing is refunded. You can undo this right after.",
  ].filter(Boolean);
}

/** What a change did, in one short sentence and in full, with why each person left out was left out. */
export function accessSummary(result: AccessDone, change: AccessChange): { short: string; words: string } {
  const changed = result.changed.length;
  // A write that could not be read back may have landed: never "Nothing was changed." then.
  const head =
    changed > 0
      ? change === "revoke"
        ? `Access removed for ${count(changed, "student", "students")}.`
        : `Access given back to ${count(changed, "student", "students")}.`
      : result.unknown.length
        ? "No change could be confirmed."
        : "Nothing was changed.";
  const left = result.already.length + result.notStudent.length + result.unread.length + result.unknown.length + result.failed.length;
  if (left === 0) return { short: head, words: head };
  const why = [
    result.already.length ? `${count(result.already.length, "student", "students")} already had ${change === "revoke" ? "no access" : "access"}` : "",
    result.notStudent.length ? `${count(result.notStudent.length, "address is", "addresses are")} not a student of this course` : "",
    result.unread.length ? `${count(result.unread.length, "student's access", "students' access")} could not be read, so ${result.unread.length === 1 ? "it was" : "they were"} not changed` : "",
    result.unknown.length
      ? `${count(result.unknown.length, "student's access was", "students' access was")} changed but could not be confirmed, so it may or may not be ${change === "revoke" ? "removed" : "back"}. Review again to see`
      : "",
    result.failed.length ? `${count(result.failed.length, "student's access", "students' access")} did not change, because something went wrong; try again` : "",
  ].filter(Boolean);
  const out = `${left.toLocaleString("en-US")} ${left === 1 ? "was" : "were"} left out`;
  return { short: `${head} ${out}.`, words: `${head} ${out}: ${why.join("; ")}.` };
}

const day = (seconds: number) => (Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : "");

/** The selection as a spreadsheet file: one line a student, every cell quoted and never a formula (lib/csv.ts). */
export function studentsCsv(lines: readonly StudentLine[], courseTitle: string, lessons: number): string {
  const rows = [
    csvLine(["Email", "Course", "Joined", "Last here", "Lessons done", "Lessons", "Access", "Labels"]),
    ...lines.map((line) =>
      csvLine([line.email, courseTitle, day(line.since), day(line.lastSeen), line.done, lessons, line.removed ? "Removed" : "Has access", line.labels === null ? "Not read" : line.labels.join(", ")]),
    ),
  ];
  return rows.join("\r\n");
}
