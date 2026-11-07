/**
 * 279 [H3-4], unit 2: another of the store's courses given to many students at
 * once, with no payment and no email, and taken back right after; and the
 * students filtered by when they were last here (lib/student-bulk-rules.ts,
 * lib/student-bulk.ts, lib/imported-purchases.ts,
 * app/api/store/students/route.ts, components/students-bulk.tsx,
 * app/studio/students/page.tsx).
 *
 * Through the real route, session, store and courses: a gift is the same
 * record an import or the API writes (lib/imported-purchases.ts), marked as
 * the studio's, so the course opens for that address exactly as one brought
 * over does and the buyer sees it as given by the store, never as a sale. The
 * review says, before anything is written, who would get it, who has it
 * given already, who already studies it, who was taken off it and whose
 * record could not be read; the confirmation acts only on the count reviewed
 * (otherwise 409, nothing written); the studio requests it reads and writes
 * are taken before it reads and before it writes; the answer is person by
 * person; the undo takes back only what the studio gave, never an import, a
 * gift or a sale. No email is sent; nothing is given while the plan's renewal
 * is unpaid.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/students/route";
import { StudentsBulk } from "@/components/students-bulk";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import {
  GIVE_REFUSALS,
  SEEN_WORDS,
  type StudentLine,
  filterStudents,
  givable,
  giveReadUnits,
  giveReviewLines,
  giveSummary,
  giveWriteUnits,
  readFilters,
} from "@/lib/student-bulk-rules";
import { applyGive, readGiveAsk, reviewGive } from "@/lib/student-bulk";
import { STUDIO_GIVE_JOB, grantImported, importedFor, importedKey, isGivenByStore } from "@/lib/imported-purchases";
import { paidCourses, setBlocked, touchStudent } from "@/lib/learn";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { redisPipeline } from "@/lib/redis";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Review = { changes: number; already: number; student: number; removed: number; otherWay: number; unread: number };
type Reply = {
  ok?: boolean;
  error?: string;
  message?: string;
  review?: Review;
  change?: string;
  asked?: number;
  changed?: string[];
  already?: string[];
  student?: string[];
  removed?: string[];
  otherWay?: string[];
  unread?: string[];
  unknown?: string[];
  failed?: string[];
};

const DAY = 86_400;
const NOW = 1_800_000_000;
const line = (email: string, lastSeen: number): StudentLine => ({ email, since: NOW - 200 * DAY, lastSeen, done: 0, removed: false, labels: [] });

async function main(): Promise<void> {
  part("The rules");
  is("last here, read from the address", [readFilters({ seen: "recent" }).seen, readFilters({ seen: "away30" }).seen, readFilters({ seen: "away90" }).seen], ["recent", "away30", "away90"]);
  is("anything else is no filter", [readFilters({ seen: "away7" }).seen, readFilters({ seen: ["recent"] }).seen, readFilters({}).seen], ["any", "any", "any"]);
  const lines = [line("today@example.com", NOW - 3600), line("month@example.com", NOW - 45 * DAY), line("long@example.com", NOW - 120 * DAY), line("never@example.com", 0)];
  const seen = (value: "recent" | "away30" | "away90") => filterStudents(lines, 2, { progress: "any", access: "any", label: "", seen: value }, NOW).shown.map((l) => l.email);
  is("here in the last 30 days", seen("recent"), ["today@example.com"]);
  is("not here for 30 days or more, or never", seen("away30"), ["month@example.com", "long@example.com", "never@example.com"]);
  is("not here for 90 days or more, or never", seen("away90"), ["long@example.com", "never@example.com"]);
  is("each choice is said in plain words", Object.values(SEEN_WORDS).every((words) => /^(Here|Not here) /.test(words)), true);
  is("a course that can be given: not a membership, not a call, and a course", [givable({ course: { id: "c" }, recurring: null, call: null }), givable({ course: { id: "c" }, recurring: { interval: "month" }, call: null }), givable({ course: null, recurring: null, call: null })], [true, false, false]);
  is(
    "studio requests, at the most each step can take: every read before reading, every write and read back before writing",
    [giveReadUnits(1), giveReadUnits(18), giveReadUnits(19), giveReadUnits(500), giveWriteUnits(1, "give"), giveWriteUnits(10, "give"), giveWriteUnits(11, "give"), giveWriteUnits(500, "give"), giveWriteUnits(1, "takeback"), giveWriteUnits(500, "takeback")],
    [1, 1, 2, 26, 2, 2, 3, 51, 1, 75],
  );
  is(
    "who is asked, read safely: each address once, in lower case, and the course to give",
    readGiveAsk({ change: "give", to: "p_cake", emails: ["Ana@Example.com", "ana@example.com", "no address", "ben@example.com"], expect: 2 }),
    { ok: true, ask: { change: "give", to: "p_cake", emails: ["ana@example.com", "ben@example.com"], expect: 2 } },
  );
  is(
    "refused: no change named, no course, nobody",
    [readGiveAsk({ change: "refund", to: "p", emails: ["a@x.co"] }), readGiveAsk({ change: "give", emails: ["a@x.co"] }), readGiveAsk({ change: "takeback", to: "p", emails: [] })].map((r) => (r.ok ? "" : r.error)),
    ["change", "to", "none"],
  );
  is("every refusal says what to do", Object.values(GIVE_REFUSALS).every((words) => /^(Choose|Select|Review|Open|Nothing) /.test(words)), true);
  is(
    "the review, before anything is written",
    giveReviewLines({ changes: 2, already: 1, student: 1, removed: 1, otherWay: 0, unread: 1 }, "give", "Cake Course"),
    [
      "2 people will get Cake Course, with no payment.",
      "1 person already has it given: left as they are.",
      "1 person already studies it: left as they are.",
      "1 person was taken off it: left as they are. Give their access back from that course's students.",
      "1 person's record could not be read just now: left as they are.",
      "No email is sent. They see it the next time they sign in with this address. You can undo this right after.",
    ],
  );
  is(
    "the answer: how many, and for the rest, why",
    giveSummary({ asked: 4, changed: ["a@x.co"], already: [], student: [], removed: [], otherWay: ["b@x.co"], unread: [], unknown: ["c@x.co"], failed: ["d@x.co"] }, "takeback", "Cake Course").words,
    "Cake Course taken back from 1 person. 3 were left out: 1 person has it another way (a sale, an import or a gift), which is not taken back here; 1 person's change could not be confirmed, so it may or may not be done. Review again to see; 1 person's change did not land, because something went wrong; try again.",
  );
  is("a gift from the studio is shown as given by the store; an import, a sale or a gift from a buyer is not", [isGivenByStore(STUDIO_GIVE_JOB), isGivenByStore("api:key1"), isGivenByStore("gift:abc"), isGivenByStore("0123456789abcdef01234567")], [true, true, false, false]);
  is("the buyer's purchases say a studio gift is the store's", readFileSync("lib/buyer-orders.ts", "utf8").includes("isGivenByStore(given.job)"), true);

  part("A store with two courses");
  redis.clear();
  const owner = "giver@example.com";
  await claimHandle(owner, "givershop", "Giver Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestGiver00001", true);
  await setSubscription(owner, { customerId: "cus_giver", subscriptionId: "sub_giver", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Giver Shop", address: "1 Main St, Portland, OR 97201" });
  const bread = await addProduct(owner, "Bread Course", "Ten loaves.", "49", null);
  const cake = await addProduct(owner, "Cake Course", "Five cakes.", "59", null);
  const plain = await addProduct(owner, "Flour Guide", "A list.", "9", null);
  if (!bread.ok || !cake.ok || !plain.ok) throw new Error("no product");
  const courseOf = async (productId: string) => {
    let course = emptyCourse();
    const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "One" });
    if (!added.ok) throw new Error("no lesson");
    course = added.course;
    await saveCourse(course, ROOM);
    const set = await setProductCourse(owner, productId, { id: course.id, lessons: 1 });
    if (!set.ok) throw new Error("not a course");
    return course;
  };
  const breadCourse = await courseOf(bread.product.id);
  const cakeCourse = await courseOf(cake.product.id);
  let store = (await storeForEmail(owner))!;
  const now = Math.floor(Date.now() / 1000);
  for (const email of ["ana@example.com", "ben@example.com", "cy@example.com", "dee@example.com"]) await touchStudent(breadCourse.id, email, now, ROOM);
  // cy already studies Cake; dee was taken off Cake; ben was brought over with Cake by an import.
  await touchStudent(cakeCourse.id, "cy@example.com", now, ROOM);
  await touchStudent(cakeCourse.id, "dee@example.com", now, ROOM);
  await setBlocked(store, cakeCourse.id, "dee@example.com", true);
  await grantImported(store.statsId!, "0123456789abcdef01234567", [{ email: "ben@example.com", productId: cake.product.id, items: null }], now, store.sid, store);
  store = (await storeForEmail(owner))!;
  const given = async (email: string) => (await importedFor({ ...store, pastBuyers: true }, email)).filter((p) => p.productId === cake.product.id).map((p) => p.job);

  part("Through the studio's route");
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = { cookie }) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/students", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const to = cake.product.id;
  const asked = ["ana@example.com", "ben@example.com", "cy@example.com", "dee@example.com", "zed@example.com"];
  const keysBefore = new Set(await redis.keys());
  const review = await post({ action: "review", change: "give", to, emails: asked });
  is("the review says exactly what it would do", [review.status, review.body.review], [200, { changes: 2, already: 1, student: 1, removed: 1, otherWay: 0, unread: 0 }]);
  is("and writes nothing", [await given("ana@example.com"), await given("zed@example.com")], [[], []]);
  const stale = await post({ action: "apply", change: "give", to, emails: asked, expect: 3 });
  is("a count that is not the one reviewed is refused, with what it would do now, nothing written", [stale.status, stale.body.error, stale.body.review?.changes, await given("ana@example.com")], [409, "changed", 2, []]);
  const noCount = await post({ action: "apply", change: "give", to, emails: asked });
  is("a confirmation always carries the count it confirms", [noCount.status, noCount.body.error], [400, "expect"]);
  const applied = await post({ action: "apply", change: "give", to, emails: asked, expect: 2 });
  is(
    "given: each person's own result",
    [applied.status, applied.body.changed?.sort(), applied.body.already, applied.body.student, applied.body.removed, applied.body.unread, applied.body.unknown, applied.body.failed],
    [200, ["ana@example.com", "zed@example.com"], ["ben@example.com"], ["cy@example.com"], ["dee@example.com"], [], [], []],
  );
  store = (await storeForEmail(owner))!;
  is("written as the studio's gift, and the store reads its given courses", [await given("ana@example.com"), store.pastBuyers], [[STUDIO_GIVE_JOB], true]);
  is("the course opens for them, as one brought over does", [(await paidCourses(store, "ana@example.com")).has(cake.product.id), (await paidCourses(store, "zed@example.com")).has(cake.product.id)], [true, true]);
  is("ben keeps what the import gave him, untouched", await given("ben@example.com"), ["0123456789abcdef01234567"]);
  const created = (await redis.keys()).filter((key: string) => !keysBefore.has(key));
  is("no email, sequence or refund is started", created.filter((key: string) => /^nl:(mail|wf|ses|refund|outbox)/.test(key)), []);

  const backReview = await post({ action: "review", change: "takeback", to, emails: ["ana@example.com", "ben@example.com", "cy@example.com", "zed@example.com"] });
  is("taking back: only what the studio gave; an import is not the studio's to take", backReview.body.review, { changes: 2, already: 1, student: 0, removed: 0, otherWay: 1, unread: 0 });
  const undone = await post({ action: "apply", change: "takeback", to, emails: applied.body.changed, expect: applied.body.changed!.length });
  is("undone, exactly: those it gave no longer have it", [undone.status, undone.body.changed?.sort(), await given("ana@example.com"), await given("zed@example.com")], [200, ["ana@example.com", "zed@example.com"], [], []]);
  is("and the course no longer opens for them", (await paidCourses(store, "ana@example.com")).has(cake.product.id), false);
  is("ben's import is still there", await given("ben@example.com"), ["0123456789abcdef01234567"]);

  is("not a course: refused", (await post({ action: "review", change: "give", to: plain.product.id, emails: ["ana@example.com"] })).body.error, "product");
  const stranger = await post({ action: "apply", change: "give", to, emails: ["ana@example.com"], expect: 1 }, {});
  is("no session: refused, and nothing given", [stranger.status, await given("ana@example.com")], [401, []]);

  part("Unknown is never read as done, nor changed by guess");
  const pipeline = redis.pipeline.bind(redis);
  const anaKey = importedKey(store.statsId!, "ana@example.com");
  let garble = 0;
  redis.pipeline = async (commands: (string | number)[][]) => {
    const replies = await pipeline(commands);
    if (garble > 0 && commands.some((c) => c[0] === "HGET" && c[1] === anaKey)) {
      garble -= 1;
      if (garble === 0) return replies.map((reply, i) => (commands[i][0] === "HGET" && commands[i][1] === anaKey ? 42 : reply));
    }
    return replies;
  };
  garble = 1;
  const unread = await post({ action: "review", change: "give", to, emails: ["ana@example.com"] });
  is("a record that cannot be read is counted as unread, never as a change", unread.body.review, { changes: 0, already: 0, student: 0, removed: 0, otherWay: 0, unread: 1 });
  garble = 1;
  const notGuessed = await post({ action: "apply", change: "give", to, emails: ["ana@example.com"], expect: 0 });
  is("and nothing is given by guess", [notGuessed.body.changed, notGuessed.body.unread, await given("ana@example.com")], [[], ["ana@example.com"], []]);
  garble = 2;
  const unconfirmed = await post({ action: "apply", change: "give", to, emails: ["ana@example.com"], expect: 1 });
  is("a gift whose result cannot be read back is said as unconfirmed, never as done", [unconfirmed.body.changed, unconfirmed.body.unknown], [[], ["ana@example.com"]]);
  garble = 0;
  redis.pipeline = pipeline;
  await redisPipeline([["HDEL", anaKey, to]]);

  const target = { productId: to, courseId: cakeCourse.id };
  const units: number[] = [];
  const refusedRead = await applyGive(store, target, { change: "give", to, emails: ["ana@example.com", "zed@example.com"], expect: 2 }, async (n) => (units.push(n), { ok: false, reason: "used", message: "Used." }));
  is("studio requests refused before reading: nothing read, nothing given", [refusedRead.kind, units, await given("ana@example.com")], ["refused", [giveReadUnits(2)], []]);
  const paidUnits: number[] = [];
  let calls = 0;
  const refusedWrite = await applyGive(store, target, { change: "give", to, emails: ["ana@example.com", "zed@example.com"], expect: 2 }, async (n) => (paidUnits.push(n), (calls += 1) === 1 ? { ok: true } : { ok: false, reason: "used", message: "Used." }));
  is("studio requests refused before writing: nothing given", [refusedWrite.kind, paidUnits, await given("ana@example.com")], ["refused", [giveReadUnits(2), giveWriteUnits(2, "give")], []]);
  const reviewUnits: number[] = [];
  const reviewed = await reviewGive(store, target, { change: "give", to, emails: ["ana@example.com"], expect: null }, async (n) => (reviewUnits.push(n), { ok: true }));
  is("a review takes its reads first", [reviewed.kind, reviewUnits], ["review", [giveReadUnits(1)]]);
  const unpaid = { ...store, subscriptionActive: true, renewalUnpaidSince: now - DAY };
  const paused = await applyGive(unpaid, target, { change: "give", to, emails: ["ana@example.com"], expect: 1 }, async () => ({ ok: true }));
  is("nothing is given while the plan's renewal is unpaid", [paused.kind, paused.kind === "refused" ? paused.reason : "", await given("ana@example.com")], ["refused", "paused_unpaid", []]);

  part("The screen");
  const studentLines = [line("ana@example.com", now), line("ben@example.com", now)];
  const html = renderToStaticMarkup(
    createElement(StudentsBulk, { productId: bread.product.id, courseTitle: "Bread Course", lessons: 1, lines: studentLines, canTag: true, canExport: true, others: [{ id: to, title: "Cake Course" }] }),
  );
  const component = readFileSync("components/students-bulk.tsx", "utf8");
  is(
    "giving another course is one of the actions; once chosen, the course is picked by its name from a labelled list",
    [html.includes("Give another course"), component.includes('htmlFor="students-give"'), component.includes("Course to give"), component.includes("others.map((course)")],
    [true, true, true, true],
  );
  is("said plainly: no payment, no email", html.includes("with no payment") && html.includes("No email is sent"), true);
  const none = renderToStaticMarkup(createElement(StudentsBulk, { productId: bread.product.id, courseTitle: "Bread Course", lessons: 1, lines: studentLines, canTag: true, canExport: true, others: [] }));
  is("with no other course, the action is not offered", none.includes("Give another course"), false);
  const page = readFileSync("app/studio/students/page.tsx", "utf8");
  is("the page filters by when they were last here and offers the other courses that can be given", [page.includes('name="seen"'), page.includes("givable(")], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
