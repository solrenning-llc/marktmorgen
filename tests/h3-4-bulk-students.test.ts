/**
 * 279 [H3-4], unit 1: the students of a course, filtered (progress, access,
 * label), many selected at once, and their access taken away or given back,
 * a label put on or off, or the selection downloaded as a file
 * (lib/student-bulk-rules.ts, lib/student-bulk.ts,
 * app/api/store/students/route.ts, components/students-bulk.tsx,
 * app/studio/students/page.tsx).
 *
 * Through the real route, session, store and course: every change is reviewed
 * first, with the exact count that the confirmation then acts on (a count
 * that moved in between is refused and reviewed again, nothing written); the
 * answer says, person by person, who changed, who was already so, who is not
 * a student, whose access could not be read (never changed by guess) and whose
 * change could not be confirmed; the undo is the opposite change for exactly
 * those it changed. The studio requests a change uses are taken before it
 * writes. No email is sent and no refund is made: refunds stay one at a time.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/students/route";
import { StudentsBulk } from "@/components/students-bulk";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import {
  ACCESS_REFUSALS,
  MAX_STUDENT_ACTION,
  STUDENTS_PER_PAGE,
  accessSummary,
  accessUnits,
  filterStudents,
  labelUnits,
  listUnits,
  oppositeAccess,
  progressOf,
  readFilters,
  studentsCsv,
  type StudentLine,
} from "@/lib/student-bulk-rules";
import { accessStates, applyAccess, readAccessAsk, reviewAccess, studentList } from "@/lib/student-bulk";
import { emailKey, markLesson, setBlocked, studentsOf, touchStudent } from "@/lib/learn";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { allowanceUsed } from "@/lib/store-allowance";
import { redisPipeline } from "@/lib/redis";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Reply = {
  ok?: boolean;
  error?: string;
  message?: string;
  review?: { changes: number; already: number; notStudent: number; unread: number };
  change?: string;
  asked?: number;
  changed?: string[];
  already?: string[];
  notStudent?: string[];
  unread?: string[];
  unknown?: string[];
  failed?: string[];
};

const line = (email: string, done: number, removed: boolean, labels: string[] | null): StudentLine => ({ email, since: 1_790_000_000, lastSeen: 1_790_086_400, done, removed, labels });

async function main(): Promise<void> {
  part("The rules");
  is("progress: not started, started, finished", [progressOf(0, 5), progressOf(2, 5), progressOf(5, 5), progressOf(7, 5), progressOf(0, 0), progressOf(1, 0)], ["none", "started", "finished", "finished", "none", "started"]);
  is("filters read from the address, the label as it will be kept", readFilters({ progress: "finished", access: "removed", label: "  Workshop   May " }), { progress: "finished", access: "removed", label: "Workshop May" });
  is("anything else is no filter", readFilters({ progress: ["finished", "none"], access: "nobody", label: 5 as unknown as string }), { progress: "any", access: "any", label: "" });
  const lines = [line("ana@example.com", 5, false, ["VIP"]), line("ben@example.com", 2, false, ["vip", "b"]), line("cy@example.com", 0, true, []), line("dee@example.com", 0, false, null)];
  is("by progress", filterStudents(lines, 5, { progress: "none", access: "any", label: "" }).shown.map((l) => l.email), ["cy@example.com", "dee@example.com"]);
  is("by access", filterStudents(lines, 5, { progress: "any", access: "removed", label: "" }).shown.map((l) => l.email), ["cy@example.com"]);
  is(
    "by label, in any case; a student whose labels could not be read is left out and counted, never guessed",
    filterStudents(lines, 5, { progress: "any", access: "active", label: "VIP" }),
    { shown: [lines[0], lines[1]], labelsUnknown: 1 },
  );
  is("no label filter: nobody is left out for labels", filterStudents(lines, 5, { progress: "any", access: "any", label: "" }).labelsUnknown, 0);
  is("the undo is the opposite change", [oppositeAccess("revoke"), oppositeAccess("grant")], ["grant", "revoke"]);
  is(
    "studio requests taken before the work, by how much there is: a change's writes (two commands a person) and its read-back, twenty commands to a request",
    [accessUnits(1), accessUnits(10), accessUnits(11), accessUnits(100), accessUnits(MAX_STUDENT_ACTION), listUnits(0), listUnits(100), labelUnits(100)],
    [1, 2, 2, 11, 51, 0, 5, 4],
  );
  is("one page of students is a bounded read", STUDENTS_PER_PAGE, 100);
  is(
    "who is asked, read safely: each address once, in lower case; nothing else",
    readAccessAsk({ change: "revoke", emails: ["Ana@Example.com", "ana@example.com", "not-an-address", 7, "ben@example.com"], expect: 2 }),
    { ok: true, ask: { change: "revoke", emails: ["ana@example.com", "ben@example.com"], expect: 2 } },
  );
  is(
    "refused: no change named, nobody, too many",
    [
      readAccessAsk({ change: "refund", emails: ["ana@example.com"] }),
      readAccessAsk({ change: "grant", emails: [] }),
      readAccessAsk({ change: "grant", emails: Array.from({ length: MAX_STUDENT_ACTION + 1 }, (_, i) => `p${i}@example.com`) }),
      readAccessAsk({ change: "grant", emails: "ana@example.com" }),
    ].map((r) => (r.ok ? "" : r.error)),
    ["change", "none", "many", "none"],
  );
  is("every refusal says what to do", Object.values(ACCESS_REFUSALS).every((words) => /^(Choose|Select|Review|Open) /.test(words)), true);
  is(
    "the answer says how many changed and, for the rest, why",
    accessSummary({ asked: 6, changed: ["a@x.co", "b@x.co"], already: ["c@x.co"], notStudent: ["d@x.co"], unread: ["e@x.co"], unknown: ["f@x.co"], failed: [] }, "revoke").words,
    "Access removed for 2 students. 4 were left out: 1 student already had no access; 1 address is not a student of this course; 1 student's access could not be read, so it was not changed; 1 student's access was changed but could not be confirmed, so it may or may not be removed. Review again to see.",
  );
  is("all done, said short", accessSummary({ asked: 1, changed: ["a@x.co"], already: [], notStudent: [], unread: [], unknown: [], failed: [] }, "grant").words, "Access given back to 1 student.");
  is(
    "a change that did not land says so",
    accessSummary({ asked: 1, changed: [], already: [], notStudent: [], unread: [], unknown: [], failed: ["a@x.co"] }, "grant").words,
    "Nothing was changed. 1 was left out: 1 student's access did not change, because something went wrong; try again.",
  );
  // Codex J, review 5808577854 on #3035 (LOW): a write that could not be read back may have landed.
  const unconfirmedOnly = accessSummary({ asked: 1, changed: [], already: [], notStudent: [], unread: [], unknown: ["a@x.co"], failed: [] }, "revoke");
  is(
    "a change that could not be confirmed is never said as nothing changed, in full or in the short live line",
    [unconfirmedOnly.words.startsWith("Nothing was changed."), unconfirmedOnly.short.startsWith("Nothing was changed."), unconfirmedOnly.words.includes("it may or may not be removed")],
    [false, false, true],
  );
  is(
    "nor when some of it did not land either",
    accessSummary({ asked: 2, changed: [], already: [], notStudent: [], unread: [], unknown: ["a@x.co"], failed: ["b@x.co"] }, "grant").short.startsWith("Nothing was changed."),
    false,
  );
  const csv = studentsCsv([line("ana@example.com", 5, false, ["VIP"]), line("cy@example.com", 0, true, null)], "=SUM(1,2)", 5);
  is("the file: a header, one line a student, every cell quoted and never a formula", csv.split("\r\n"), [
    `"Email","Course","Joined","Last here","Lessons done","Lessons","Access","Labels"`,
    `"ana@example.com","'=SUM(1,2)","2026-09-21","2026-09-22","5","5","Has access","VIP"`,
    `"cy@example.com","'=SUM(1,2)","2026-09-21","2026-09-22","0","5","Removed","Not read"`,
  ]);

  part("A store with a course and four students");
  redis.clear();
  const owner = "students@example.com";
  await claimHandle(owner, "studentshop", "Student Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestStudents01", true);
  await setSubscription(owner, { customerId: "cus_students", subscriptionId: "sub_students", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Student Shop", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(owner, "Bread Course", "Ten loaves.", "49", null);
  const plain = await addProduct(owner, "Flour Guide", "A list.", "9", null);
  if (!made.ok || !plain.ok) throw new Error("no product");
  let course = emptyCourse();
  for (const title of ["One", "Two"]) {
    const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title });
    if (!added.ok) throw new Error("no lesson");
    course = added.course;
  }
  await saveCourse(course, ROOM);
  const set = await setProductCourse(owner, made.product.id, { id: course.id, lessons: 2 });
  if (!set.ok) throw new Error("not a course");
  const store = (await storeForEmail(owner))!;
  const [one] = course.modules[0].lessons.map((l) => l.id);
  const now = Math.floor(Date.now() / 1000);
  for (const email of ["ana@example.com", "ben@example.com", "cy@example.com", "dee@example.com"]) await touchStudent(course.id, email, now, ROOM);
  await markLesson(course.id, "ana@example.com", one, true, ROOM);
  await setBlocked(store, course.id, "dee@example.com", true);
  const blocked = async () => {
    const read = await studentsOf(course);
    if (!read) throw new Error("the course's students could not be read");
    return read.students.filter((s) => s.blocked).map((s) => s.email).sort();
  };
  is("dee was taken off the course, one at a time, as before", await blocked(), ["dee@example.com"]);
  is(
    "each person's access, read exactly from the same records the course reads",
    [...(await accessStates(course.id, ["ana@example.com", "dee@example.com", "zed@example.com"])).entries()],
    [["ana@example.com", "active"], ["dee@example.com", "removed"], ["zed@example.com", "none"]],
  );

  part("The list, read exactly and paid for before it is read");
  const list = store.listId!;
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const [anaRaw] = await redisPipeline([["HGET", leadsKey(list), "ana@example.com"]]);
  await redisPipeline([["HSET", leadsKey(list), "ana@example.com", JSON.stringify({ ...JSON.parse(String(anaRaw)), tags: ["VIP"] })]]);
  await redisPipeline([["HSET", leadsKey(list), "ben@example.com", "{not json"]]);
  const charged: number[] = [];
  const read = await studentList(store, course, "0", async (units) => (charged.push(units), true), true);
  const byEmail = new Map((read?.lines ?? []).map((l) => [l.email, l]));
  is("every student, with progress and access", [read?.total, [...byEmail.keys()].sort(), byEmail.get("ana@example.com")?.done, byEmail.get("dee@example.com")?.removed], [4, ["ana@example.com", "ben@example.com", "cy@example.com", "dee@example.com"], 1, true]);
  is("labels: a contact's own, none for one not on the list, unknown for one that cannot be read", [byEmail.get("ana@example.com")?.labels, byEmail.get("cy@example.com")?.labels, byEmail.get("ben@example.com")?.labels], [["VIP"], [], null]);
  is("the reading is paid for first, by how many rows and labels it reads", charged, [listUnits(4) + labelUnits(4)]);
  const pipeline = redis.pipeline.bind(redis);
  let commandsSeen = 0;
  redis.pipeline = async (commands: (string | number)[][]) => ((commandsSeen += commands.length), pipeline(commands));
  const refusedRead = await studentList(store, course, "0", async () => false, true);
  redis.pipeline = pipeline;
  is("refused: nothing more is read than the page's size", [refusedRead, commandsSeen <= 3], [null, true]);

  part("Through the studio's route");
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = { cookie }) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/students", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const id = made.product.id;
  const asked = ["ana@example.com", "ben@example.com", "dee@example.com", "zed@example.com"];
  const keysBefore = new Set(await redis.keys());
  const review = await post({ action: "review", id, change: "revoke", emails: asked });
  is("the review says exactly what it would do", [review.status, review.body.review], [200, { changes: 2, already: 1, notStudent: 1, unread: 0 }]);
  is("and writes nothing", await blocked(), ["dee@example.com"]);
  const stale = await post({ action: "apply", id, change: "revoke", emails: asked, expect: 3 });
  is("a count that is not the one reviewed is refused, with what it would do now, nothing written", [stale.status, stale.body.error, stale.body.review?.changes, await blocked()], [409, "changed", 2, ["dee@example.com"]]);
  const noCount = await post({ action: "apply", id, change: "revoke", emails: asked });
  is("a confirmation always carries the count it confirms", [noCount.status, noCount.body.error], [400, "expect"]);
  const applied = await post({ action: "apply", id, change: "revoke", emails: asked, expect: 2 });
  is(
    "applied: each person's own result",
    [applied.status, applied.body.changed?.sort(), applied.body.already, applied.body.notStudent, applied.body.unread, applied.body.unknown, applied.body.failed],
    [200, ["ana@example.com", "ben@example.com"], ["dee@example.com"], ["zed@example.com"], [], [], []],
  );
  is("the course's own list reads them as taken off", await blocked(), ["ana@example.com", "ben@example.com", "dee@example.com"]);
  const created = (await redis.keys()).filter((key: string) => !keysBefore.has(key));
  is("no email, sequence or refund is started: nothing is written but the access and the counts", created.filter((key: string) => /^nl:(mail|wf|ses|refund|outbox)/.test(key)), []);
  const undone = await post({ action: "apply", id, change: oppositeAccess("revoke"), emails: applied.body.changed, expect: applied.body.changed!.length });
  is("undone, exactly: those it changed have access again", [undone.status, undone.body.changed?.sort(), await blocked()], [200, ["ana@example.com", "ben@example.com"], ["dee@example.com"]]);
  const again = await post({ action: "review", id, change: "grant", emails: ["ana@example.com"] });
  is("giving access to one who has it changes nothing", again.body.review, { changes: 0, already: 1, notStudent: 0, unread: 0 });

  is("not a course: refused", (await post({ action: "review", id: plain.product.id, change: "grant", emails: ["ana@example.com"] })).body.error, "product");
  const many = await post({ action: "review", id, change: "grant", emails: Array.from({ length: MAX_STUDENT_ACTION + 1 }, (_, i) => `p${i}@example.com`) });
  is("more people than one change takes: refused, saying what to do", [many.status, many.body.error, many.body.message], [400, "many", ACCESS_REFUSALS.many]);
  is("an action that is not one", (await post({ action: "refund", id, change: "grant", emails: ["ana@example.com"] })).body.error, "unknown");
  const stranger = await post({ action: "apply", id, change: "revoke", emails: ["ana@example.com"], expect: 1 }, {});
  is("no session: refused, and nothing changed", [stranger.status, await blocked()], [401, ["dee@example.com"]]);

  part("Unknown is never read as done, nor changed by guess");
  const blockedKey = `nl:course:${course.id}:blocked`;
  let garble = 0;
  let throwFor = "";
  redis.pipeline = async (commands: (string | number)[][]) => {
    // The write of one person's access fails (setBlocked's own two commands), before anything of it is written.
    if (throwFor && commands.length === 2 && commands[0][0] === "SADD" && commands[0][1] === blockedKey && commands[0][2] === emailKey(throwFor)) throw new Error("injected: the write failed");
    const replies = await pipeline(commands);
    if (garble > 0 && commands.some((c) => c[0] === "SMISMEMBER")) {
      garble -= 1;
      if (garble === 0) return replies.map((reply, i) => (commands[i][0] === "SMISMEMBER" ? "garbled" : reply));
    }
    return replies;
  };

  garble = 1;
  const unreadReview = await post({ action: "review", id, change: "revoke", emails: ["ana@example.com", "ben@example.com"] });
  is("access that cannot be read is counted as unread, never as a change", unreadReview.body.review, { changes: 0, already: 0, notStudent: 0, unread: 2 });
  garble = 1;
  const unreadApply = await post({ action: "apply", id, change: "revoke", emails: ["ana@example.com", "ben@example.com"], expect: 0 });
  is("and is not changed by guess", [unreadApply.status, unreadApply.body.changed, unreadApply.body.unread?.sort(), await blocked()], [200, [], ["ana@example.com", "ben@example.com"], ["dee@example.com"]]);

  garble = 2;
  const unconfirmed = await post({ action: "apply", id, change: "revoke", emails: ["ana@example.com"], expect: 1 });
  is("a change whose result cannot be read back is said as unconfirmed, never as done", [unconfirmed.body.changed, unconfirmed.body.unknown], [[], ["ana@example.com"]]);
  garble = 0;
  await setBlocked(store, course.id, "ana@example.com", false);

  throwFor = "ben@example.com";
  const partly = await post({ action: "apply", id, change: "revoke", emails: ["ana@example.com", "ben@example.com"], expect: 2 });
  throwFor = "";
  is("one write that failed: that person is said as not changed, the other as done", [partly.body.changed, partly.body.failed], [["ana@example.com"], ["ben@example.com"]]);
  await setBlocked(store, course.id, "ana@example.com", false);
  redis.pipeline = pipeline;

  const notPaid = await applyAccess(store, course.id, { change: "revoke", emails: ["ana@example.com", "ben@example.com"], expect: 2 }, async (units) => ({ ok: false, reason: "used", message: `No room for ${units}.` }));
  is("studio requests refused: nothing is written", [notPaid.kind, await blocked()], ["refused", ["dee@example.com"]]);
  let paidUnits = 0;
  const paid = await applyAccess(store, course.id, { change: "revoke", emails: ["ana@example.com", "ben@example.com"], expect: 2 }, async (units) => ((paidUnits = units), { ok: true }));
  is("taken before writing, by how many it changes", [paid.kind, paidUnits], ["done", accessUnits(2)]);
  await setBlocked(store, course.id, "ana@example.com", false);
  await setBlocked(store, course.id, "ben@example.com", false);

  part("Every access read and write is paid for before it happens (Codex P, review 5808427711 on #3035)");
  // A studio request is priced at twenty commands (tests/plan-cost-registry.ts, UNIT_COST.studio).
  const STUDIO_COMMANDS = 20;
  const studentsKeyOf = `nl:course:${course.id}:students`;
  const metered = (answer: boolean | ((paidSoFar: number) => boolean) = true) => {
    const log = { events: [] as string[], commands: 0, paid: 0, uncovered: [] as string[] };
    redis.pipeline = async (commands: (string | number)[][]) => {
      log.commands += commands.length;
      const kinds = commands.map((c) => String(c[0])).join("+");
      log.events.push(kinds);
      if (log.commands > STUDIO_COMMANDS * log.paid) log.uncovered.push(`${kinds} at ${log.commands} commands with ${log.paid} requests taken`);
      return pipeline(commands);
    };
    const pay = async (units: number): Promise<{ ok: true } | { ok: false; reason: string; message: string }> => {
      if (!(typeof answer === "function" ? answer(log.paid) : answer)) return { ok: false, reason: "used", message: `No room for ${units}.` };
      log.paid += units;
      log.events.push(`pay ${units}`);
      return { ok: true };
    };
    return { log, pay };
  };
  const reads = (events: string[]) => events.filter((e) => e.includes("HMGET") || e.includes("SMISMEMBER"));

  const two = metered();
  const twoDone = await applyAccess(store, course.id, { change: "revoke", emails: ["ana@example.com", "ben@example.com"], expect: 2 }, two.pay);
  redis.pipeline = pipeline;
  is("a change: paid for before its first read, and every command it sends is covered", [twoDone.kind, two.log.events[0]?.startsWith("pay "), two.log.uncovered], ["done", true, []]);
  await setBlocked(store, course.id, "ana@example.com", false);
  await setBlocked(store, course.id, "ben@example.com", false);

  const hundred = Array.from({ length: 100 }, (_, i) => `s${String(i).padStart(3, "0")}@example.com`);
  for (const email of hundred) await touchStudent(course.id, email, now, ROOM);
  const big = metered();
  const bigDone = await applyAccess(store, course.id, { change: "revoke", emails: hundred, expect: 100 }, big.pay);
  redis.pipeline = pipeline;
  is(
    "a hundred people: the reads, the writes and the read-back are all inside the requests taken first",
    [bigDone.kind, bigDone.kind === "done" ? bigDone.done.changed.length : -1, big.log.uncovered, big.log.commands <= STUDIO_COMMANDS * big.log.paid],
    ["done", 100, [], true],
  );
  await applyAccess(store, course.id, { change: "grant", emails: hundred, expect: 100 }, async () => ({ ok: true }));

  const noRead = metered(false);
  const noReadDone = await applyAccess(store, course.id, { change: "revoke", emails: ["ana@example.com", "ben@example.com"], expect: 2 }, noRead.pay);
  redis.pipeline = pipeline;
  is("studio requests refused before the read: nothing is read and nothing written", [noReadDone.kind, reads(noRead.log.events), await blocked()], ["refused", [], ["dee@example.com"]]);
  const noWrite = metered((paidSoFar) => paidSoFar === 0);
  const noWriteDone = await applyAccess(store, course.id, { change: "revoke", emails: ["ana@example.com", "ben@example.com"], expect: 2 }, noWrite.pay);
  redis.pipeline = pipeline;
  is("refused after the read: nothing is written", [noWriteDone.kind, noWrite.log.uncovered, await blocked()], ["refused", [], ["dee@example.com"]]);
  await setBlocked(store, course.id, "ana@example.com", false);
  await setBlocked(store, course.id, "ben@example.com", false);

  const ask = { change: "revoke" as const, emails: ["ana@example.com", "ben@example.com", "zed@example.com"], expect: null };
  const look = metered();
  const looked = await reviewAccess(course.id, ask, look.pay);
  redis.pipeline = pipeline;
  is(
    "a review: paid for before it reads, every command covered, and it says what it would do",
    [look.log.events[0]?.startsWith("pay "), look.log.uncovered, looked],
    [true, [], { kind: "review", review: { changes: 2, already: 0, notStudent: 1, unread: 0 } }],
  );
  const noLook = metered(false);
  const notLooked = await reviewAccess(course.id, ask, noLook.pay);
  redis.pipeline = pipeline;
  is("a review refused its studio requests reads nothing", [(notLooked as { kind?: string }).kind, reads(noLook.log.events)], ["refused", []]);

  // Through the route: past the one request every studio write takes for its session, store and role
  // (lib/studio-route.ts, studioAccess), the access read's own request is taken before it, on review and on apply.
  const takenBeforeRead = async (body: Record<string, unknown>) => {
    const before = await allowanceUsed(store, "studio");
    let atRead = -1;
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (atRead < 0 && commands.some((c) => c[0] === "HMGET" && c[1] === studentsKeyOf)) {
        redis.pipeline = pipeline;
        atRead = (await allowanceUsed(store, "studio")) - before;
      }
      return pipeline(commands);
    };
    const answer = await post(body);
    redis.pipeline = pipeline;
    return [answer.status, atRead];
  };
  is("the route's review takes its studio requests before it reads", await takenBeforeRead({ action: "review", id, change: "revoke", emails: ["ana@example.com"] }), [200, 2]);
  is("the route's change takes its studio requests before it reads", await takenBeforeRead({ action: "apply", id, change: "revoke", emails: ["ana@example.com"], expect: 1 }), [200, 2]);
  await setBlocked(store, course.id, "ana@example.com", false);

  part("The screen");
  const html = renderToStaticMarkup(
    createElement(StudentsBulk, { productId: id, courseTitle: "Bread Course", lessons: 2, lines: lines.slice(0, 3), canTag: true, canExport: true }),
  );
  is("a box for every student, named by who it selects", ["ana@example.com", "ben@example.com", "cy@example.com"].every((email) => html.includes(`aria-label="Select ${email}"`)), true);
  is("one to select every student on this page, saying how many", html.includes("Select all 3 students on this page"), true);
  is("how many are selected, said where a screen reader hears it", html.includes('role="status"') && html.includes("0 of 3 selected"), true);
  is("every action named; refunds are not one of them", ["Remove access", "Give access back", "Add a label", "Take a label off", "Download"].every((words) => html.includes(words)) && !/(<button[^>]*>|<span class="block text-ink">)[^<]*refund/i.test(html), true);
  is("refunds are said to stay one at a time", html.includes("Refunds stay one at a time"), true);
  is("targets of at least 44 pixels", (html.match(/min-h-11/g) ?? []).length >= 4, true);
  const narrow = renderToStaticMarkup(createElement(StudentsBulk, { productId: id, courseTitle: "Bread Course", lessons: 2, lines: lines.slice(0, 1), canTag: false, canExport: false }));
  is("labels and the file only for a role that may use them", [narrow.includes("Add a label"), narrow.includes("Download"), narrow.includes("Remove access")], [false, false, true]);

  const page = readFileSync("app/studio/students/page.tsx", "utf8");
  is("the page is the products role's, and reads one bounded page", [page.includes('"products"'), page.includes("studentList("), page.includes("STUDENTS_PER_PAGE")], [true, true, true]);
  is("the course's own page leads to it", readFileSync("app/studio/course/[product]/page.tsx", "utf8").includes('"students"'), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
