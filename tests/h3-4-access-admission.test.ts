/**
 * 279 [H3-4], unit 1, review of #3035 (Codex P, review 5808427711): a change
 * of many students' access pays its studio requests before it reads anything.
 *
 * The finding: applyAccess read every person's access (HMGET, SMISMEMBER)
 * before it asked for its studio requests, so a refused store had its first
 * read for free; the review read the same with no studio requests taken at
 * all; and what it took, a request for ten people, covered 200 commands where
 * a hundred people take 204 (the first read, the writes and the read back).
 *
 * Proved here on the real database calls, counted as they are sent: in the
 * review and in the change, for 1, 99, 100 and the most one change takes,
 * every command and every byte through the database is inside what was
 * already paid for when it is sent (a studio request is twenty commands and
 * fifty kilobytes, tests/plan-cost-registry.ts, UNIT_COST.studio); a refusal
 * reads nothing; and, through the route, the studio count is taken before the
 * course's students are read, for the review as for the change.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/students/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { MAX_STUDENT_ACTION } from "@/lib/student-bulk-rules";
import { applyAccess, reviewAccess } from "@/lib/student-bulk";
import { setBlocked, touchStudent } from "@/lib/learn";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

/** What one studio request pays for in the database (tests/plan-cost-registry.ts, UNIT_COST.studio). */
const UNIT_COMMANDS = 20;
const UNIT_BYTES = 50_000;

type Command = (string | number)[];
type Event = { kind: "pay"; units: number } | { kind: "db"; commands: Command[]; bytes: number };

const bytesOf = (value: unknown): number => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null), "utf8");

/** Each address at the longest a student's can be, so what the database sends back is at its largest. */
const longAddress = (i: number) => `${"a".repeat(50)}${String(i).padStart(4, "0")}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`;

async function main(): Promise<void> {
  part("A store with a course and as many students as one change takes");
  redis.clear();
  const owner = "admission@example.com";
  await claimHandle(owner, "admissionshop", "Admission Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestAdmission1", true);
  await setSubscription(owner, { customerId: "cus_admission", subscriptionId: "sub_admission", active: true, tier: "scale", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Admission Shop", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(owner, "Bread Course", "Ten loaves.", "49", null);
  if (!made.ok) throw new Error("no product");
  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "One" });
  if (!added.ok) throw new Error("no lesson");
  course = added.course;
  await saveCourse(course, ROOM);
  const set = await setProductCourse(owner, made.product.id, { id: course.id, lessons: 1 });
  if (!set.ok) throw new Error("not a course");
  const store = (await storeForEmail(owner))!;
  const everyone = Array.from({ length: MAX_STUDENT_ACTION }, (_, i) => longAddress(i));
  is("the addresses are as long as an address can be", everyone.every((email) => email.length >= 250 && email.length <= 254), true);
  const now = Math.floor(Date.now() / 1000);
  for (const email of everyone) await touchStudent(course.id, email, now, ROOM);

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
  const pay = async (units: number) => (events.push({ kind: "pay", units }), { ok: true as const });
  const refuse = async (units: number) => (events.push({ kind: "pay", units }), { ok: false as const, reason: "used", message: "No room." });

  /** Whether every database call was inside what was already paid for when it was sent, counted together. */
  const covered = (log: Event[]) => {
    let paid = 0;
    let commands = 0;
    let bytes = 0;
    let first = "";
    for (const event of log) {
      if (!first) first = event.kind;
      if (event.kind === "pay") {
        paid += event.units;
        continue;
      }
      commands += event.commands.length;
      bytes += event.bytes;
      if (commands > paid * UNIT_COMMANDS || bytes > paid * UNIT_BYTES) return { ok: false, first, paid, commands, bytes };
    }
    return { ok: true, first, paid, commands, bytes };
  };
  const writes = (log: Event[]) => log.filter((e) => e.kind === "db" && e.commands.some((c) => c[0] === "SADD" || c[0] === "SREM")).length;

  for (const people of [1, 99, 100, MAX_STUDENT_ACTION]) {
    part(`${people} ${people === 1 ? "student" : "students"}`);
    const emails = everyone.slice(0, people);

    watch();
    const review = await reviewAccess(course.id, { change: "revoke", emails, expect: null }, pay);
    const reviewed = covered(events);
    unwatch();
    is(`the review says what it would do, ${people}`, review, { kind: "review", review: { changes: people, already: 0, notStudent: 0, unread: 0 } });
    is(`the review pays first, and every command and byte it reads is inside what it paid (${JSON.stringify(reviewed)})`, [reviewed.first, reviewed.ok], ["pay", true]);

    watch();
    const refusedReview = await reviewAccess(course.id, { change: "revoke", emails, expect: null }, refuse);
    const refusedReviewDb = events.filter((e) => e.kind === "db").length;
    unwatch();
    is(`a review refused its studio requests reads nothing, ${people}`, [refusedReview.kind, refusedReviewDb], ["refused", 0]);

    watch();
    const refusedApply = await applyAccess(store, course.id, { change: "revoke", emails, expect: people }, refuse);
    const refusedApplyDb = events.filter((e) => e.kind === "db").length;
    unwatch();
    is(`a change refused its studio requests reads and writes nothing, ${people}`, [refusedApply.kind, refusedApplyDb], ["refused", 0]);

    watch();
    const applied = await applyAccess(store, course.id, { change: "revoke", emails, expect: people }, pay);
    const changed = covered(events);
    const wrote = writes(events);
    unwatch();
    is(`the change is made for each of them, ${people}`, [applied.kind, applied.kind === "done" ? applied.done.changed.length : -1], ["done", people]);
    is(
      `the change pays first, and its first read, every write and the read back are each inside what was paid when sent (${JSON.stringify(changed)})`,
      [changed.first, changed.ok, wrote > 0],
      ["pay", true, true],
    );
    if (people === 100) is("a hundred people: 204 commands, all paid for", [changed.commands, changed.paid * UNIT_COMMANDS >= 204], [204, true]);
    for (const email of emails) await setBlocked(store, course.id, email, false);
  }

  part("Through the studio's route: the studio count comes before the course's students are read");
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/students", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const studentsKey = `nl:course:${course.id}:students`;
  /** The studio requests taken before the first read of the course's students, besides the request itself. */
  const takenBeforeRead = async (body: Record<string, unknown>) => {
    const log: Command[] = [];
    redis.pipeline = async (commands: Command[]) => (log.push(...commands), pipeline(commands));
    const answer = await post(body);
    redis.pipeline = pipeline;
    const first = log.findIndex((c) => c[0] === "HMGET" && c[1] === studentsKey);
    const taken = log.slice(0, first < 0 ? log.length : first).filter((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:allow:studio:"));
    return { status: answer.status, read: first >= 0, takes: taken.length, units: taken.reduce((n, c) => n + Number(c[2]), 0) };
  };
  const two = everyone.slice(0, 2);
  const reviewRoute = await takenBeforeRead({ action: "review", id: made.product.id, change: "revoke", emails: two });
  is("the review: the request itself, and then what reading them takes, before they are read", [reviewRoute.status, reviewRoute.read, reviewRoute.takes >= 2, reviewRoute.units >= 2], [200, true, true, true]);
  const applyRoute = await takenBeforeRead({ action: "apply", id: made.product.id, change: "revoke", emails: two, expect: 2 });
  is("the change: the same, before the first read", [applyRoute.status, applyRoute.read, applyRoute.takes >= 2, applyRoute.units >= 2], [200, true, true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
