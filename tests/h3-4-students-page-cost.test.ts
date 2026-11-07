/**
 * 279 [H3-4], unit 1, review of #3035: the studio's students page pays for
 * its reading of the course's students before the first read, at its most,
 * in commands and in bytes.
 *
 * The finding: the page took listUnits + labelUnits (5 + 4 = 9 studio
 * requests for a hundred students) after the page of students was already
 * scanned, and the reading that followed could pass far beyond them: every
 * student's lessons done read whole (up to 16 KB each, DONE_SET_BYTES), the
 * blocked students, and each contact's record (up to 20 KB,
 * CONTACT_ROW_BYTES), where labelUnits counted 2 KB.
 *
 * Proved here on the real database calls, counted as they are sent, for the
 * worst case a store can hold: addresses as long as an address can be, a
 * course of MAX_LESSONS lessons and every one of them marked done (with as
 * many again marked and later taken out), contacts at the most labels, and
 * the blocked list both small and past BLOCKED_READ_MAX. On every page of the
 * walk, with labels and without: the page pays before its first read; every
 * command and every byte through the database is inside what was already
 * paid when it is sent; a refused page reads nothing; a page holds at most
 * 25 students; and walking the pages shows every student of the course.
 */
import { MAX_CONTACT_TAGS, MAX_TAG_LENGTH } from "@/lib/contact-rules";
import { MAX_LESSONS, editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { leadsKey } from "@/lib/contacts";
import { emailKey, setBlocked, touchStudent } from "@/lib/learn";
import { STUDENTS_PER_PAGE } from "@/lib/student-bulk-rules";
import { studentList } from "@/lib/student-bulk";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductCourse, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

/** What one studio request pays for in the database (tests/plan-cost-registry.ts, UNIT_COST.studio). */
const UNIT_COMMANDS = 20;
const UNIT_BYTES = 50_000;
/** The most students one page of the studio's list shows. */
const PAGE_MOST = 25;

type Command = (string | number)[];
type Event = { kind: "pay"; units: number } | { kind: "db"; commands: Command[]; bytes: number };

const bytesOf = (value: unknown): number => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null), "utf8");

/** Each address at the longest a student's can be, so what the database sends back is at its largest. */
const longAddress = (i: number) => `${"a".repeat(50)}${String(i).padStart(4, "0")}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`;

/** A contact at the most labels, with long titles and a long name, as the list keeps one. */
function bigContact(i: number): string {
  const title = (n: number) => `${"€".repeat(70)}"${String(n).padStart(9, "0")}`;
  return JSON.stringify({
    agreed: true,
    agreedAt: new Date(0).toISOString(),
    firstAt: new Date(0).toISOString(),
    lastAt: new Date(0).toISOString(),
    titles: Array.from({ length: 20 }, (_, n) => title(n)),
    ids: Array.from({ length: 20 }, (_, n) => `p${String(n).padStart(11, "0")}`),
    source: "buyer",
    unsub: false,
    unsubAt: "",
    t: "",
    name: `${"€".repeat(96)}${String(i).padStart(4, "0")}`,
    tags: Array.from({ length: MAX_CONTACT_TAGS }, (_, n) => `${n === 0 ? "VIP" : `L${n}`}${"€".repeat(MAX_TAG_LENGTH - 3)}`.slice(0, MAX_TAG_LENGTH)),
    importedAt: "",
  });
}

async function main(): Promise<void> {
  part("A store with a course of the most lessons, every one marked done by a hundred students at their longest");
  redis.clear();
  const owner = "pagecost@example.com";
  await claimHandle(owner, "pagecostshop", "Page Cost Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  const made = await addProduct(owner, "Bread Course", "Ten loaves.", "49", null);
  if (!made.ok) throw new Error("no product");
  let course = emptyCourse();
  for (let n = 0; n < MAX_LESSONS; n += 1) {
    const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: `Lesson ${n}` });
    if (!added.ok) throw new Error(`no lesson ${n}`);
    course = added.course;
  }
  await saveCourse(course, ROOM);
  const set = await setProductCourse(owner, made.product.id, { id: course.id, lessons: MAX_LESSONS });
  if (!set.ok) throw new Error("not a course");
  const store = (await storeForEmail(owner))!;
  if (!store.listId) throw new Error("no list");
  const lessonIds = course.modules.flatMap((m) => m.lessons.map((l) => l.id));
  is("the course holds the most lessons a course can", lessonIds.length, MAX_LESSONS);

  const everyone = Array.from({ length: 100 }, (_, i) => longAddress(i));
  is("the addresses are as long as an address can be", everyone.every((email) => email.length >= 250 && email.length <= 254), true);
  const now = Math.floor(Date.now() / 1000);
  const gone = Array.from({ length: MAX_LESSONS }, (_, n) => `gone${String(n).padStart(8, "0")}`);
  for (const [i, email] of everyone.entries()) {
    await touchStudent(course.id, email, now, ROOM);
    await redis.pipeline([["SADD", `nl:course:${course.id}:done:${emailKey(email)}`, ...lessonIds, ...gone]]);
    await redis.pipeline([["HSET", leadsKey(store.listId), email, bigContact(i)]]);
  }
  for (const email of everyone.slice(0, 30)) await setBlocked(store, course.id, email, true);

  const pipeline = redis.pipeline.bind(redis);
  let events: Event[] = [];
  const watch = () => {
    events = [];
    redis.pipeline = async (commands: Command[]) => {
      const replies = await pipeline(commands);
      events.push({ kind: "db", commands, bytes: commands.reduce((sum, command) => sum + command.reduce((n: number, arg) => n + bytesOf(String(arg)), 0), 0) + bytesOf(replies) });
      return replies;
    };
  };
  const unwatch = () => {
    redis.pipeline = pipeline;
  };
  const pay = async (units: number) => (events.push({ kind: "pay", units }), true);
  const refuse = async (units: number) => (events.push({ kind: "pay", units }), false);

  /** Whether every database call was inside what was already paid for when it was sent, counted together. */
  const covered = (log: Event[]) => {
    let paid = 0;
    let commands = 0;
    let bytes = 0;
    let first = "";
    let ok = true;
    for (const event of log) {
      if (!first) first = event.kind;
      if (event.kind === "pay") {
        paid += event.units;
        continue;
      }
      commands += event.commands.length;
      bytes += event.bytes;
      if (commands > paid * UNIT_COMMANDS || bytes > paid * UNIT_BYTES) ok = false;
    }
    return { ok, first, paid, commands, bytes };
  };

  is("a page of the studio's list is at most 25 students", STUDENTS_PER_PAGE <= PAGE_MOST, true);

  for (const blocked of ["30 blocked", "past the blocked list read whole"]) {
    if (blocked !== "30 blocked") {
      // Blocked people who are not on the page, so the blocked list is past what is read whole.
      await redis.pipeline([["SADD", `nl:course:${course.id}:blocked`, ...Array.from({ length: 250 }, (_, n) => `${String(n).padStart(32, "f")}`)]]);
    }
    for (const withLabels of [true, false]) {
      part(`Every page, ${withLabels ? "with" : "without"} labels, ${blocked}`);
      const seen = new Set<string>();
      let cursor = "0";
      let pages = 0;
      let worst = { paid: 0, commands: 0, bytes: 0 };
      let allCovered = true;
      let allPaidFirst = true;
      let allSmall = true;
      let labelsRead = false;
      do {
        watch();
        const page = await studentList(store, course, cursor, pay, withLabels);
        const cost = covered(events);
        labelsRead ||= events.some((e) => e.kind === "db" && e.commands.some((c) => c[0] === "HMGET" && c[1] === leadsKey(store.listId!)));
        unwatch();
        if (!page) throw new Error("the page could not be read");
        pages += 1;
        allCovered &&= cost.ok;
        allPaidFirst &&= cost.first === "pay";
        allSmall &&= page.lines.length <= PAGE_MOST;
        if (cost.bytes > worst.bytes) worst = { paid: cost.paid, commands: cost.commands, bytes: cost.bytes };
        for (const line of page.lines) seen.add(line.email);
        cursor = page.next;
      } while (cursor !== "0" && pages < 50);
      console.log(`    worst page: ${JSON.stringify(worst)} (${Math.ceil(Math.max(worst.commands / UNIT_COMMANDS, worst.bytes / UNIT_BYTES))} requests at least)`);
      is("every page pays before its first read", allPaidFirst, true);
      is("every command and byte of every page is inside what was paid when it is sent", allCovered, true);
      is("every page shows at most 25 students", allSmall, true);
      is("walking the pages shows every student of the course", [seen.size, everyone.every((email) => seen.has(email))], [everyone.length, true]);
      is("the labels are read only when asked for", labelsRead, withLabels);
    }
  }

  part("A page refused its studio requests reads nothing");
  watch();
  const refused = await studentList(store, course, "0", refuse, true);
  const read = events.filter((e) => e.kind === "db").length;
  unwatch();
  is("nothing is read and nothing is shown", [refused, read], [null, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
