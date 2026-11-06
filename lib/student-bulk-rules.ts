/**
 * The rules of acting on many of a course's students at once (279 [H3-4],
 * unit 1), shared by the studio's screen and the server
 * (lib/student-bulk.ts, app/api/store/students/route.ts). Browser-safe.
 *
 * What it does: filters one page of a course's students by progress, access,
 * label and when they were last here; takes access away from those selected
 * or gives it back to those who were taken off; gives them another of the
 * store's courses with no payment, or takes back one the studio gave (unit
 * 2); and says, person by person, what happened. Labels on
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

/**
 * Studio requests a change of access takes before it writes: each person is
 * about two commands (the write of their access and their share of the reads
 * around it), and a studio request is priced at twenty commands
 * (tests/plan-cost-registry.ts, UNIT_COST.studio). At least one.
 */
export function accessUnits(people: number): number {
  return Math.max(1, Math.ceil(Math.max(0, Math.floor(people)) / 10));
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
/** When they were last here: in the last 30 days, or not for 30 or 90 days (never counts as not here). */
export type SeenFilter = "any" | "recent" | "away30" | "away90";
/** `seen` absent: any. */
export type StudentFilters = { progress: Progress | "any"; access: AccessFilter; label: string; seen?: SeenFilter };

export const SEEN_WORDS: Record<Exclude<SeenFilter, "any">, string> = {
  recent: "Here in the last 30 days",
  away30: "Not here for 30 days or more",
  away90: "Not here for 90 days or more",
};
const DAY_SECONDS = 86_400;
const SEEN_DAYS: Record<Exclude<SeenFilter, "any">, number> = { recent: 30, away30: 30, away90: 90 };

const one = (value: unknown) => (typeof value === "string" ? value : "");

/** The filters from the page's address; anything that is not one of them is no filter. */
export function readFilters(query: Record<string, unknown>): StudentFilters {
  const progress = one(query.progress);
  const access = one(query.access);
  const seen = one(query.seen);
  return {
    progress: progress === "none" || progress === "started" || progress === "finished" ? progress : "any",
    access: access === "active" || access === "removed" ? access : "any",
    label: one(query.label).replace(/\s+/gu, " ").trim().slice(0, 80),
    seen: seen === "recent" || seen === "away30" || seen === "away90" ? seen : "any",
  };
}

/** One student as the list shows them. `labels` null: their contact could not be read, so not known. */
export type StudentLine = { email: string; since: number; lastSeen: number; done: number; removed: boolean; labels: string[] | null };

/**
 * The students that match the filters. With a label asked for, a student
 * whose labels could not be read is left out and counted (`labelsUnknown`),
 * so the screen says so: never guessed as having it or not.
 */
export function filterStudents(lines: readonly StudentLine[], lessons: number, filters: StudentFilters, now = Math.floor(Date.now() / 1000)): { shown: StudentLine[]; labelsUnknown: number } {
  const wanted = filters.label ? labelKey(filters.label) : "";
  const seen = filters.seen ?? "any";
  const since = seen === "any" ? 0 : now - SEEN_DAYS[seen] * DAY_SECONDS;
  let labelsUnknown = 0;
  const shown = lines.filter((line) => {
    if (filters.progress !== "any" && progressOf(line.done, lessons) !== filters.progress) return false;
    const here = Number.isFinite(line.lastSeen) && line.lastSeen > 0 && line.lastSeen >= since;
    if (seen === "recent" && !here) return false;
    if ((seen === "away30" || seen === "away90") && here) return false;
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
  const head = changed === 0 ? "Nothing was changed." : change === "revoke" ? `Access removed for ${count(changed, "student", "students")}.` : `Access given back to ${count(changed, "student", "students")}.`;
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

/**
 * A course that can be given from the list of students: a course, and
 * neither a membership (its access is its subscription) nor a call. The same
 * as an import or the API can give (lib/api-write.ts, giveAccess).
 */
export function givable(product: { course?: { id: string } | null; recurring?: unknown; call?: unknown }): boolean {
  return Boolean(product.course) && !product.recurring && !product.call;
}

/** give: another course, with no payment; takeback: a course the studio gave, taken back (the undo). */
export type GiveChange = "give" | "takeback";

/**
 * Studio requests taken before anything is read, on a review and on a
 * confirmation alike, at the most the reading can take: one HGET a person
 * (what the store gave them of that course) and, for every hundred people,
 * the two commands that read whether they study it or were taken off it.
 * Twenty commands to a studio request (tests/plan-cost-registry.ts,
 * UNIT_COST.studio); at least one.
 */
export function giveReadUnits(people: number): number {
  const m = Math.max(0, Math.floor(people));
  return Math.max(1, Math.ceil((m + 2 * Math.ceil(m / 100)) / 20));
}
/** The commands a gift adds once, whatever the count: the store marked as one that gives courses, its data room taken, its paid window reserved. */
export const GIVE_FIXED_COMMANDS = 20;
/**
 * Studio requests taken before anything is written, at the most the writing
 * can take: to give, one HSETNX and one HGET read back a person, and
 * GIVE_FIXED_COMMANDS; to take back, the record read again just before, one
 * HDEL and one HGET read back a person. At least one.
 */
export function giveWriteUnits(people: number, change: GiveChange): number {
  const n = Math.max(0, Math.floor(people));
  return Math.max(1, Math.ceil((change === "give" ? 2 * n + GIVE_FIXED_COMMANDS : 3 * n) / 20));
}

export type GiveRefusal = "change" | "to" | "none" | "many" | "product" | "expect" | "paused_unpaid" | "paused_disputed" | "store_full" | "unavailable";

export const GIVE_REFUSALS: Record<GiveRefusal, string> = {
  change: "Choose whether to give the course or take it back.",
  to: "Choose the course to give.",
  none: ACCESS_REFUSALS.none,
  many: ACCESS_REFUSALS.many,
  product: "Choose one of your courses that can be given: not a membership or a call.",
  expect: ACCESS_REFUSALS.expect,
  paused_unpaid: "Nothing was given: your plan's renewal payment did not go through, so new gifts wait until it is paid. Check the notice at the top of your studio. You can still take back a course you gave.",
  paused_disputed: "Nothing was given: a payment for your plan is disputed with your bank, so new gifts wait until it is settled. Check the notice at the top of your studio. You can still take back a course you gave.",
  store_full: "Nothing was given: your store's data room is full. Delete something you no longer need, such as old posts, drafts or contacts, then try again.",
  unavailable: "Nothing was given just now. Try again in a minute.",
};

/**
 * What giving or taking back would do, read now, with nothing written.
 *   changes   would get it (give), or would have it taken back (takeback)
 *   already   has it given here already (give); was not given it here (takeback)
 *   student   already studies it (give)
 *   removed   was taken off that course (give): giving it would not open it
 *   otherWay  has it from a sale, an import or a gift, not the studio's to take back (takeback)
 *   unread    their record could not be read: left as they are
 */
export type GiveReview = { changes: number; already: number; student: number; removed: number; otherWay: number; unread: number };

/** What it did, person by person: as the review, and `unknown` (written, not read back) and `failed` (read back as before). */
export type GiveDone = { asked: number; changed: string[]; already: string[]; student: string[]; removed: string[]; otherWay: string[]; unread: string[]; unknown: string[]; failed: string[] };

/** The lines a review shows before the creator confirms. */
export function giveReviewLines(review: GiveReview, change: GiveChange, title: string): string[] {
  const giving = change === "give";
  return [
    giving ? `${count(review.changes, "person", "people")} will get ${title}, with no payment.` : `${count(review.changes, "person", "people")} will no longer have ${title}.`,
    review.already ? (giving ? `${count(review.already, "person already has", "people already have")} it given: left as they are.` : `${count(review.already, "person was", "people were")} not given it here: left as they are.`) : "",
    review.student ? `${count(review.student, "person already studies", "people already study")} it: left as they are.` : "",
    review.removed ? `${count(review.removed, "person was", "people were")} taken off it: left as they are. Give their access back from that course's students.` : "",
    review.otherWay ? `${count(review.otherWay, "person has", "people have")} it another way (a sale, an import or a gift): not taken back here.` : "",
    review.unread ? `${count(review.unread, "person's record", "people's records")} could not be read just now: left as they are.` : "",
    giving ? "No email is sent. They see it the next time they sign in with this address. You can undo this right after." : "No email is sent and nothing is refunded. You can give it again right after.",
  ].filter(Boolean);
}

/** What giving or taking back did, in one short sentence and in full, with why each person left out was left out. */
export function giveSummary(result: GiveDone, change: GiveChange, title: string): { short: string; words: string } {
  const giving = change === "give";
  const changed = result.changed.length;
  const head = changed === 0 ? "Nothing was changed." : giving ? `${title} given to ${count(changed, "person", "people")}.` : `${title} taken back from ${count(changed, "person", "people")}.`;
  const left = result.already.length + result.student.length + result.removed.length + result.otherWay.length + result.unread.length + result.unknown.length + result.failed.length;
  if (left === 0) return { short: head, words: head };
  const n = (list: string[]) => list.length;
  const why = [
    n(result.already) ? (giving ? `${count(n(result.already), "person already had", "people already had")} it given` : `${count(n(result.already), "person was", "people were")} not given it here`) : "",
    n(result.student) ? `${count(n(result.student), "person already studies", "people already study")} it` : "",
    n(result.removed) ? `${count(n(result.removed), "person was", "people were")} taken off it; give their access back from that course's students` : "",
    n(result.otherWay) ? `${count(n(result.otherWay), "person has", "people have")} it another way (a sale, an import or a gift), which is not taken back here` : "",
    n(result.unread) ? `${count(n(result.unread), "person's record", "people's records")} could not be read, so nothing was changed for them` : "",
    n(result.unknown) ? `${count(n(result.unknown), "person's change", "people's changes")} could not be confirmed, so ${n(result.unknown) === 1 ? "it" : "they"} may or may not be done. Review again to see` : "",
    n(result.failed) ? `${count(n(result.failed), "person's change", "people's changes")} did not land, because something went wrong; try again` : "",
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
