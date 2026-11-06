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
 * change uses are taken. After it, each person is read back: only what reads
 * back as asked is said as done. No email is sent and nothing is refunded.
 *
 * Nothing about a person's access is read before it is paid for (review of
 * #3035, Codex P, 5808427711): the review and the change take the studio
 * requests their first read costs before it (accessReadUnits), and the change
 * those of its writes and its read back before the first write
 * (accessChangeUnits), each at its most, in commands and in bytes.
 */
import { STUDENT_ROW_BYTES } from "@/lib/api-read-rules";
import { readAddresses, leadsKey, parseContact } from "@/lib/contacts";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { STUDIO_GIVE_JOB, STUDIO_GIVE_PREFIX, grantImported, givenMany, takeGivenMany } from "@/lib/imported-purchases";
import { integrationPauseWord } from "@/lib/integration-pause";
import { DataRoomError } from "@/lib/store-data";
import { type Store, ensureStatsId, setPastBuyers, storeRef } from "@/lib/store";
import { type Course } from "@/lib/course";
import { emailKey, setBlocked, studentPage } from "@/lib/learn";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import {
  ACCESS_READ_BATCH,
  ACCESS_WRITES_AT_ONCE,
  type AccessChange,
  type AccessDone,
  type AccessRefusal,
  type AccessReview,
  type GiveChange,
  type GiveDone,
  type GiveRefusal,
  type GiveReview,
  MAX_STUDENT_ACTION,
  STUDENTS_PER_PAGE,
  type StudentLine,
  giveReadUnits,
  giveWriteUnits,
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

/** What one studio request pays for in the database (tests/plan-cost-registry.ts, UNIT_COST.studio): twenty commands and fifty kilobytes. */
export const STUDIO_UNIT_COMMANDS = 20;
export const STUDIO_UNIT_BYTES = 50_000;
/** A key of a course's or a buyer's record as sent (nl:course:<id>:students, nl:learn:paid:<store>:<person>), with room. */
const KEY_BYTES = 128;
/** A person as their access is filed: the hashed address (lib/learn.ts, emailKey). */
const PERSON_KEY_BYTES = 32;
/** One answer that is a number (a flag, a count), with its framing. */
const NUMBER_BYTES = 8;

/** What a piece of work sends through the database and gets back, at its most. */
export type DbWork = { commands: number; bytes: number };

/** The studio requests that pay for `work`: never fewer than its commands or its bytes need; none for no work. */
export function studioUnits(work: DbWork): number {
  const { commands, bytes } = work;
  if (![commands, bytes].every((n) => Number.isFinite(n) && n >= 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil(Math.max(commands / STUDIO_UNIT_COMMANDS, bytes / STUDIO_UNIT_BYTES));
}

const people = (n: number) => Math.max(0, Math.floor(n));

/**
 * Reading `n` people's access (accessStates): a command pair for every
 * ACCESS_READ_BATCH of them, each pair the two keys and every person's hashed
 * address twice, and back each one's row (STUDENT_ROW_BYTES at its largest)
 * and their flag.
 */
export function accessReadWork(n: number): DbWork {
  const count = people(n);
  const batches = Math.ceil(count / ACCESS_READ_BATCH);
  return { commands: 2 * batches, bytes: batches * 2 * KEY_BYTES + count * (2 * PERSON_KEY_BYTES + STUDENT_ROW_BYTES + NUMBER_BYTES) };
}

/** Writing `n` people's access (setBlocked, lib/learn.ts): two commands each, the blocked list and the buyer's cached access, and their answers. */
export function accessWriteWork(n: number): DbWork {
  const count = people(n);
  return { commands: 2 * count, bytes: count * (2 * KEY_BYTES + PERSON_KEY_BYTES + 2 * NUMBER_BYTES) };
}

/** Studio requests taken before `n` people's access is first read, by the review and by the change. */
export function accessReadUnits(n: number): number {
  return studioUnits(accessReadWork(n));
}

/** Studio requests taken before `n` people's access is changed: every write and the read back of each of them. */
export function accessChangeUnits(n: number): number {
  const write = accessWriteWork(n);
  const back = accessReadWork(n);
  return studioUnits({ commands: write.commands + back.commands, bytes: write.bytes + back.bytes });
}

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
 * or none at all, is "unknown" for that batch.
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
      else if (typeof row === "string" && row && (flag === 0 || flag === 1)) out.set(email, flag === 1 ? "removed" : "active");
      else out.set(email, "unknown");
    });
  }
  return out;
}

/** A change asked for: `expect`, the count of people the creator confirmed, or null on a review. */
export type AccessAsk = { change: AccessChange; emails: string[]; expect: number | null };

/** The people a change names, made safe: each address once, in lower case; more than MAX_STUDENT_ACTION refused, never cut. */
function readPeople(raw: Record<string, unknown>): { ok: true; emails: string[]; expect: number | null } | { ok: false; error: "none" | "many" } {
  if (!Array.isArray(raw.emails)) return { ok: false, error: "none" };
  if (raw.emails.length > MAX_STUDENT_ACTION * 2) return { ok: false, error: "many" };
  const typed = raw.emails.filter((e): e is string => typeof e === "string" && !/[\s,;"'<>()]/.test(e.trim()));
  const emails = readAddresses(typed.join("\n")).emails;
  if (emails.length > MAX_STUDENT_ACTION) return { ok: false, error: "many" };
  if (!emails.length) return { ok: false, error: "none" };
  const expect = typeof raw.expect === "number" && Number.isSafeInteger(raw.expect) && raw.expect >= 0 ? raw.expect : null;
  return { ok: true, emails, expect };
}

/** What the studio sent, made safe, or what is wrong with it. */
export function readAccessAsk(raw: Record<string, unknown>): { ok: true; ask: AccessAsk } | { ok: false; error: AccessRefusal } {
  const change = raw.change === "revoke" || raw.change === "grant" ? raw.change : null;
  if (!change) return { ok: false, error: "change" };
  const people = readPeople(raw);
  if (!people.ok) return people;
  return { ok: true, ask: { change, emails: people.emails, expect: people.expect } };
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

/** Asks for studio requests: yes, or why not. */
export type PayStudio = (units: number) => Promise<{ ok: true } | { ok: false; reason: string; message: string }>;

/** The studio requests were not given: nothing was read or written. */
type Refused = { kind: "refused"; reason: string; message: string };

/** What the change would do, with nothing written; what reading it costs is paid for first. */
export async function reviewAccess(courseId: string, ask: AccessAsk, pay: PayStudio): Promise<{ kind: "review"; review: AccessReview } | Refused> {
  const paid = await pay(accessReadUnits(ask.emails.length));
  if (!paid.ok) return { kind: "refused", reason: paid.reason, message: paid.message };
  return { kind: "review", review: reviewOf(sortOut(await accessStates(courseId, ask.emails), ask)) };
}

export type AccessApplied =
  | { kind: "done"; done: AccessDone }
  /** The count it would change now is not the one confirmed: nothing written; this is what it would do now. */
  | { kind: "stale"; review: AccessReview }
  /** The studio requests it needs were not given: nothing written (nothing read, when refused before the first read). */
  | Refused;

/**
 * The change, for those it applies to now. `pay` is asked, before anything is
 * read, for what reading everyone asked costs (accessReadUnits), and then,
 * before the first write, for what the writes and the read back of those it
 * changes cost (accessChangeUnits). Each person's write is setBlocked, at most
 * ACCESS_WRITES_AT_ONCE at a time; then each is read back, and only those read
 * back as asked are `changed`.
 */
export async function applyAccess(store: Store, courseId: string, ask: AccessAsk, pay: PayStudio): Promise<AccessApplied> {
  const reading = await pay(accessReadUnits(ask.emails.length));
  if (!reading.ok) return { kind: "refused", reason: reading.reason, message: reading.message };
  const sorted = sortOut(await accessStates(courseId, ask.emails), ask);
  if (ask.expect !== sorted.targets.length) return { kind: "stale", review: reviewOf(sorted) };
  const result: AccessDone = { asked: ask.emails.length, changed: [], already: sorted.already, notStudent: sorted.notStudent, unread: sorted.unread, unknown: [], failed: [] };
  if (!sorted.targets.length) return { kind: "done", done: result };
  const paid = await pay(accessChangeUnits(sorted.targets.length));
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

/* ------------------------------------------------------------------------
 * Unit 2: another of the store's courses given to many people at once, with
 * no payment, and taken back (the undo).
 *
 * A gift is the record an import or the API writes (lib/imported-purchases.ts,
 * grantImported), marked STUDIO_GIVE_JOB: the course opens for that address
 * as one brought over does (lib/learn.ts reads it, unchanged), and the buyer
 * sees it as given by the store, never as a sale. Taking back takes only the
 * studio's own gift, never an import, a gift paid by someone, a sale or the
 * API's. No email is sent. Every step takes its studio requests before it
 * reads and again before it writes, at the most the step can take
 * (giveReadUnits, giveWriteUnits); nothing is given while the plan's renewal
 * is unpaid or a payment for it is disputed, and in a paid window only when
 * the window is reserved (as the API's gift).
 * --------------------------------------------------------------------- */

/** A gift asked for: the course to give (`to`, a product id), and, on a confirmation, the count confirmed. */
export type GiveAsk = { change: GiveChange; to: string; emails: string[]; expect: number | null };

export function readGiveAsk(raw: Record<string, unknown>): { ok: true; ask: GiveAsk } | { ok: false; error: GiveRefusal } {
  const change = raw.change === "give" || raw.change === "takeback" ? raw.change : null;
  if (!change) return { ok: false, error: "change" };
  const to = typeof raw.to === "string" ? raw.to.trim().slice(0, 40) : "";
  if (!to) return { ok: false, error: "to" };
  const people = readPeople(raw);
  if (!people.ok) return people;
  return { ok: true, ask: { change, to, emails: people.emails, expect: people.expect } };
}

/** The course given: its product (what the record names) and its course (whose students and removals are read). */
export type GiveTarget = { productId: string; courseId: string };
/** One person's gift as read: absent from the answer is unknown, never "nothing given". */
const grantOf = <T>(map: Map<string, T>, email: string): T | "unknown" => (map.has(email) ? (map.get(email) as T) : "unknown");
type Sorted = { targets: string[]; already: string[]; student: string[]; removed: string[]; otherWay: string[]; unread: string[] };

/** Who it would act on now, and why the rest would be left, read exactly; nothing read but the course's own records and each person's gift of it. */
async function sortGive(store: Store, target: GiveTarget, ask: GiveAsk): Promise<Sorted> {
  const sorted: Sorted = { targets: [], already: [], student: [], removed: [], otherWay: [], unread: [] };
  if (ask.change === "takeback") {
    if (!store.statsId) return { ...sorted, already: [...ask.emails] };
    const now = await givenMany(store.statsId, ask.emails, target.productId);
    for (const email of ask.emails) {
      const grant = grantOf(now, email);
      if (grant === "unknown") sorted.unread.push(email);
      else if (grant === null) sorted.already.push(email);
      else if (grant.job.startsWith(STUDIO_GIVE_PREFIX)) sorted.targets.push(email);
      else sorted.otherWay.push(email);
    }
    return sorted;
  }
  const states = await accessStates(target.courseId, ask.emails);
  const open = ask.emails.filter((email) => states.get(email) === "none");
  const grants = store.statsId && open.length ? await givenMany(store.statsId, open, target.productId) : new Map<string, null>();
  for (const email of ask.emails) {
    const state = states.get(email) ?? "unknown";
    if (state === "unknown") sorted.unread.push(email);
    else if (state === "active") sorted.student.push(email);
    else if (state === "removed") sorted.removed.push(email);
    else {
      const grant = store.statsId ? grantOf(grants, email) : null;
      if (grant === "unknown") sorted.unread.push(email);
      else if (grant === null) sorted.targets.push(email);
      else sorted.already.push(email);
    }
  }
  return sorted;
}

const giveReviewOf = (s: Sorted): GiveReview => ({ changes: s.targets.length, already: s.already.length, student: s.student.length, removed: s.removed.length, otherWay: s.otherWay.length, unread: s.unread.length });

/** What it would do, with nothing written; its reads taken first. */
export async function reviewGive(store: Store, target: GiveTarget, ask: GiveAsk, pay: PayStudio): Promise<{ kind: "review"; review: GiveReview } | Refused> {
  const paid = await pay(giveReadUnits(ask.emails.length));
  if (!paid.ok) return { kind: "refused", reason: paid.reason, message: paid.message };
  return { kind: "review", review: giveReviewOf(await sortGive(store, target, ask)) };
}

export type GiveApplied = { kind: "done"; done: GiveDone } | { kind: "stale"; review: GiveReview } | Refused;

const refusedAs = (reason: GiveRefusal): Refused => ({ kind: "refused", reason, message: "" });

/**
 * The gift, or its taking back, for those it applies to now: the reads paid
 * for, then read; the count confirmed checked (otherwise nothing written);
 * the writes and their read back paid for; written; each read back, and only
 * those read back as asked said as `changed`.
 */
export async function applyGive(store: Store, target: GiveTarget, ask: GiveAsk, pay: PayStudio): Promise<GiveApplied> {
  const giving = ask.change === "give";
  const paused = giving ? integrationPauseWord(store) : null;
  if (paused) return refusedAs(paused);
  const readPaid = await pay(giveReadUnits(ask.emails.length));
  if (!readPaid.ok) return { kind: "refused", reason: readPaid.reason, message: readPaid.message };
  const sorted = await sortGive(store, target, ask);
  if (ask.expect !== sorted.targets.length) return { kind: "stale", review: giveReviewOf(sorted) };
  const result: GiveDone = { asked: ask.emails.length, changed: [], already: sorted.already, student: sorted.student, removed: sorted.removed, otherWay: sorted.otherWay, unread: sorted.unread, unknown: [], failed: [] };
  if (!sorted.targets.length) return { kind: "done", done: result };
  const writePaid = await pay(giveWriteUnits(sorted.targets.length, ask.change));
  if (!writePaid.ok) return { kind: "refused", reason: writePaid.reason, message: writePaid.message };

  let statsId = store.statsId;
  if (giving) {
    if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return refusedAs("unavailable");
    statsId = statsId ?? (await ensureStatsId(storeRef(store)))?.statsId;
    if (!statsId || !store.sid) return refusedAs("unavailable");
    // Marked first, so what is given is read as soon as it is written (lib/learn.ts reads gifts only of a store so marked).
    if (!store.pastBuyers && !(await setPastBuyers(storeRef(store)))?.pastBuyers) return refusedAs("unavailable");
    try {
      await grantImported(statsId, STUDIO_GIVE_JOB, sorted.targets.map((email) => ({ email, productId: target.productId, items: null })), undefined, store.sid, store);
    } catch (error) {
      if (error instanceof DataRoomError) return refusedAs("store_full");
      // The writes may or may not have landed: what reads back decides, person by person.
      console.error("giving a course in bulk failed", error);
    }
  } else if (statsId) {
    try {
      await takeGivenMany(statsId, sorted.targets, target.productId, STUDIO_GIVE_PREFIX);
    } catch (error) {
      console.error("taking a course back in bulk failed", error);
    }
  }
  const after = statsId ? await givenMany(statsId, sorted.targets, target.productId) : new Map<string, "unknown">();
  for (const email of sorted.targets) {
    const grant = grantOf(after, email);
    if (grant === "unknown") result.unknown.push(email);
    else if (giving ? grant !== null && grant.job === STUDIO_GIVE_JOB : grant === null) result.changed.push(email);
    else if (giving && grant !== null) result.already.push(email);
    else result.failed.push(email);
  }
  return { kind: "done", done: result };
}
