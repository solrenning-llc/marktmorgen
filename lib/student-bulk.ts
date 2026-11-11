/**
 * Acting on many of a course's students at once (279 [H3-4], unit 1): one
 * page of the list read exactly and paid for first, each person's access read
 * exactly, and access taken away or given back for many at once.
 *
 * Every write is the course's own, setBlocked (lib/learn.ts), the same one the
 * studio's single "Remove access" uses, so a student taken off here is off the
 * course exactly as one taken off there. Before anything is written each
 * person's access is read (unknown is never changed by guess), the count the
 * creator confirmed must be the count it would change now (otherwise nothing
 * is written and the review is answered again), and the studio requests the
 * change uses are taken: the read's own before it is read, on a review too,
 * and the writes' and read-back's before the first write. After it, each
 * person is read back: only what reads back as asked is said as done. No
 * email is sent and nothing is refunded.
 */
import { readAddresses, leadsKey, parseContact } from "@/lib/contacts";
import { type Course } from "@/lib/course";
import { emailKey, isStudentRowOf, setBlocked, studentPage } from "@/lib/learn";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import {
  ACCESS_READ_BATCH,
  ACCESS_WRITES_AT_ONCE,
  type AccessChange,
  type AccessDone,
  type AccessRefusal,
  type AccessReview,
  MAX_STUDENT_ACTION,
  STUDENTS_PER_PAGE,
  type StudentLine,
  accessReadUnits,
  accessUnits,
  labelUnits,
  listUnits,
} from "@/lib/student-bulk-rules";

/**
 * Where a course's students are kept and who was taken off it: the keys
 * lib/learn.ts writes (studentsKey, blockedKey). Read here, never written;
 * tests/h3-4-bulk-students.test.ts holds them to the course's own list
 * (studentsOf) and its own write (setBlocked), so a change of either fails it.
 */
const studentsKey = (courseId: string) => `nl:course:${courseId}:students`;
const blockedKey = (courseId: string) => `nl:course:${courseId}:blocked`;

/**
 * One page of a course's students, with each one's labels when `withLabels`:
 * what the page shows (lib/learn.ts, studentPage, read in its exact shape).
 * `charge` is asked for the studio requests the page's rows and labels cost
 * once their number is known and before they are read; when it says no, or
 * the page cannot be read, null, with nothing more read.
 */
export async function studentList(
  store: Store,
  course: Course,
  cursor: string,
  charge: (units: number) => Promise<boolean>,
  withLabels: boolean,
): Promise<{ lines: StudentLine[]; total: number; next: string } | null> {
  const labelled = withLabels && Boolean(store.listId);
  const page = await studentPage(course, cursor, STUDENTS_PER_PAGE, async (rows) => charge(listUnits(rows) + (labelled ? labelUnits(rows) : 0)));
  if (!page) return null;
  // HSCAN may give one student twice across pages, never on one page twice; kept once all the same.
  const seen = new Set<string>();
  const students = page.students.filter((s) => !seen.has(s.email) && Boolean(seen.add(s.email)));
  const labels = labelled ? await labelsOf(store.listId!, students.map((s) => s.email)) : students.map(() => [] as string[]);
  return {
    total: page.total,
    next: page.next,
    lines: students.map((s, i) => ({ email: s.email, since: s.since, lastSeen: s.lastSeen, done: s.done, removed: s.blocked, labels: labels[i] })),
  };
}

/**
 * Each address's labels on the store's list, in one command: none for one not
 * on the list; null for one whose record, or the whole answer, is not in its
 * exact shape: unknown, never "no labels".
 */
async function labelsOf(listId: string, emails: string[]): Promise<(string[] | null)[]> {
  if (!emails.length) return [];
  try {
    const replies = repliesFor(await redisPipeline([["HMGET", leadsKey(listId), ...emails]]), 1);
    const rows = replies ? repliesFor(replies[0], emails.length) : null;
    if (!rows) return emails.map(() => null);
    return rows.map((raw) => {
      if (raw === null) return [];
      const contact = typeof raw === "string" ? parseContact(raw) : null;
      return contact && Array.isArray(contact.tags) ? [...contact.tags] : null;
    });
  } catch (error) {
    console.error("reading students' labels failed", error);
    return emails.map(() => null);
  }
}

/** Has access, was taken off, is not a student of the course, or could not be read. */
export type AccessState = "active" | "removed" | "none" | "unknown";

/**
 * Each address's access to a course, read exactly, ACCESS_READ_BATCH at a
 * command pair: whether they are one of its students (the row the course
 * keeps) and whether they were taken off it. An answer not in its exact shape,
 * or none at all, is "unknown" for that batch; a row that is not the record the
 * course keeps for that address (lib/learn.ts isStudentRowOf) is "unknown" for
 * that person.
 */
export async function accessStates(courseId: string, emails: readonly string[]): Promise<Map<string, AccessState>> {
  const out = new Map<string, AccessState>();
  for (let from = 0; from < emails.length; from += ACCESS_READ_BATCH) {
    const batch = emails.slice(from, from + ACCESS_READ_BATCH);
    const keys = batch.map(emailKey);
    let rows: unknown[] | null = null;
    let flags: unknown[] | null = null;
    try {
      const replies = repliesFor(
        await redisPipeline([
          ["HMGET", studentsKey(courseId), ...keys],
          ["SMISMEMBER", blockedKey(courseId), ...keys],
        ]),
        2,
      );
      rows = replies ? repliesFor(replies[0], batch.length) : null;
      flags = replies ? repliesFor(replies[1], batch.length) : null;
    } catch (error) {
      console.error("reading students' access failed", error);
    }
    batch.forEach((email, i) => {
      const row = rows ? rows[i] : undefined;
      const flag = flags ? flags[i] : undefined;
      if (row === null) out.set(email, "none");
      // Only the record the course keeps for this address is a student; anything else is unknown, never active.
      else if (isStudentRowOf(row, email) && (flag === 0 || flag === 1)) out.set(email, flag === 1 ? "removed" : "active");
      else out.set(email, "unknown");
    });
  }
  return out;
}

/** A change asked for: `expect`, the count of people the creator confirmed, or null on a review. */
export type AccessAsk = { change: AccessChange; emails: string[]; expect: number | null };

/** What the studio sent, made safe, or what is wrong with it. Each address once, in lower case; more than MAX_STUDENT_ACTION refused, never cut. */
export function readAccessAsk(raw: Record<string, unknown>): { ok: true; ask: AccessAsk } | { ok: false; error: AccessRefusal } {
  const change = raw.change === "revoke" || raw.change === "grant" ? raw.change : null;
  if (!change) return { ok: false, error: "change" };
  if (!Array.isArray(raw.emails)) return { ok: false, error: "none" };
  if (raw.emails.length > MAX_STUDENT_ACTION * 2) return { ok: false, error: "many" };
  const typed = raw.emails.filter((e): e is string => typeof e === "string" && !/[\s,;"'<>()]/.test(e.trim()));
  const emails = readAddresses(typed.join("\n")).emails;
  if (emails.length > MAX_STUDENT_ACTION) return { ok: false, error: "many" };
  if (!emails.length) return { ok: false, error: "none" };
  const expect = typeof raw.expect === "number" && Number.isSafeInteger(raw.expect) && raw.expect >= 0 ? raw.expect : null;
  return { ok: true, ask: { change, emails, expect } };
}

/** Who a change would act on, and why the rest would be left, read now. */
function sortOut(states: Map<string, AccessState>, ask: AccessAsk) {
  const want: AccessState = ask.change === "revoke" ? "active" : "removed";
  const sorted = { targets: [] as string[], already: [] as string[], notStudent: [] as string[], unread: [] as string[] };
  for (const email of ask.emails) {
    const state = states.get(email) ?? "unknown";
    if (state === "unknown") sorted.unread.push(email);
    else if (state === "none") sorted.notStudent.push(email);
    else if (state === want) sorted.targets.push(email);
    else sorted.already.push(email);
  }
  return sorted;
}

const reviewOf = (s: ReturnType<typeof sortOut>): AccessReview => ({ changes: s.targets.length, already: s.already.length, notStudent: s.notStudent.length, unread: s.unread.length });

/** Asked for the studio requests a part of the work takes, before it is done. */
export type AccessPay = (units: number) => Promise<{ ok: true } | { ok: false; reason: string; message: string }>;

/** The studio requests a part of the work needed were not given: nothing more was read or written. */
type AccessRefused = { kind: "refused"; reason: string; message: string };

/** What the change would do, with nothing written. `pay` is asked for the read's studio requests before it reads. */
export async function reviewAccess(courseId: string, ask: AccessAsk, pay: AccessPay): Promise<{ kind: "review"; review: AccessReview } | AccessRefused> {
  const paid = await pay(accessReadUnits(ask.emails.length));
  if (!paid.ok) return { kind: "refused", reason: paid.reason, message: paid.message };
  return { kind: "review", review: reviewOf(sortOut(await accessStates(courseId, ask.emails), ask)) };
}

export type AccessApplied =
  | { kind: "done"; done: AccessDone }
  /** The count it would change now is not the one confirmed: nothing written; this is what it would do now. */
  | { kind: "stale"; review: AccessReview }
  | AccessRefused;

/**
 * The change, for those it applies to now. `pay` is asked for accessReadUnits
 * of everyone asked before their access is read, then for accessUnits of those
 * it changes before the first write (their writes and the read-back). Each
 * person's write is setBlocked, at most ACCESS_WRITES_AT_ONCE at a time; then
 * each is read back, and only those read back as asked are `changed`.
 */
export async function applyAccess(store: Store, courseId: string, ask: AccessAsk, pay: AccessPay): Promise<AccessApplied> {
  const readPaid = await pay(accessReadUnits(ask.emails.length));
  if (!readPaid.ok) return { kind: "refused", reason: readPaid.reason, message: readPaid.message };
  const sorted = sortOut(await accessStates(courseId, ask.emails), ask);
  if (ask.expect !== sorted.targets.length) return { kind: "stale", review: reviewOf(sorted) };
  const result: AccessDone = { asked: ask.emails.length, changed: [], already: sorted.already, notStudent: sorted.notStudent, unread: sorted.unread, unknown: [], failed: [] };
  if (!sorted.targets.length) return { kind: "done", done: result };
  const paid = await pay(accessUnits(sorted.targets.length));
  if (!paid.ok) return { kind: "refused", reason: paid.reason, message: paid.message };
  const removing = ask.change === "revoke";
  for (let from = 0; from < sorted.targets.length; from += ACCESS_WRITES_AT_ONCE) {
    await Promise.all(
      sorted.targets.slice(from, from + ACCESS_WRITES_AT_ONCE).map((email) =>
        setBlocked(store, courseId, email, removing).catch((error: unknown) => console.error("changing a student's access failed", error)),
      ),
    );
  }
  const after = await accessStates(courseId, sorted.targets);
  const asked: AccessState = removing ? "removed" : "active";
  for (const email of sorted.targets) {
    const state = after.get(email) ?? "unknown";
    if (state === asked) result.changed.push(email);
    else if (state === "unknown") result.unknown.push(email);
    else result.failed.push(email);
  }
  return { kind: "done", done: result };
}
