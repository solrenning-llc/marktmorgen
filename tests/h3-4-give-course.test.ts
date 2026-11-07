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
 * given already, who was taken off it and whose record could not be read
 * (a student's row in the course is not access, so it decides nothing); the confirmation acts only on the count reviewed
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
import { STUDIO_GIVE_JOB, STUDIO_GIVE_PREFIX, TAKE_IF_SAME, grantImported, importedFor, importedKey, isGivenByStore, takeGivenMany } from "@/lib/imported-purchases";
import { paidCourses, setBlocked, touchStudent } from "@/lib/learn";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { redisPipeline } from "@/lib/redis";
import { takeManyWithin, withinLimit } from "@/lib/request-guard";
import * as apiWrite from "@/lib/api-write";
import { GIVES_PER_DAY } from "@/lib/api-write";
import * as bulkRules from "@/lib/student-bulk-rules";
import { putMember } from "@/lib/team";
import { buyerProfile } from "@/lib/buyer-profile";
import { chargedLine } from "@/lib/buyer-orders";
import { dataUsed } from "@/lib/store-data";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Review = { changes: number; already: number; removed: number; otherWay: number; unread: number };
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
  // Pre-review of unit 2, light: a draft (hidden) or a course of limited places was given from here as any other.
  is(
    "a draft, or a course of limited places, is not given from here",
    [givable({ course: { id: "c" }, recurring: null, call: null, hidden: true, stock: null }), givable({ course: { id: "c" }, recurring: null, call: null, hidden: false, stock: 5 }), givable({ course: { id: "c" }, recurring: null, call: null, hidden: false, stock: null })],
    [false, false, true],
  );
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
  // Changed assertion (rule 23, pre-review of unit 2, MEDIO 3): the review had a "student" count and the line "1 person
  // already studies it: left as they are.", read from the student's row in the course, which is no access at all.
  is(
    "the review, before anything is written",
    giveReviewLines({ changes: 2, already: 1, removed: 1, otherWay: 0, unread: 1 }, "give", "Cake Course"),
    [
      "2 people will get Cake Course, with no payment.",
      "1 person already has it given: left as they are.",
      "1 person was taken off it: left as they are. Give their access back from that course's students.",
      "1 person's record could not be read just now: left as they are.",
      // Changed assertion (rule 23, second pre-review of unit 2, LEVE 5): the review now says that buying is not checked.
      "Whether someone already bought it is not checked here: anyone who did keeps what they paid for and also gets the gift.",
      "No email is sent. They see it the next time they sign in with this address. You can undo this right after.",
    ],
  );
  is(
    "the answer: how many, and for the rest, why",
    giveSummary({ asked: 4, changed: ["a@x.co"], already: [], removed: [], otherWay: ["b@x.co"], unread: [], unknown: ["c@x.co"], failed: ["d@x.co"] }, "takeback", "Cake Course").words,
    "Cake Course taken back from 1 person. 3 were left out: 1 person has it another way (a sale, an import or a gift), which is not taken back here; 1 person's change could not be confirmed, so it may or may not be done. Review again to see; 1 person's change did not land, because something went wrong; try again.",
  );
  is("a gift from the studio is shown as given by the store; an import, a sale or a gift from a buyer is not", [isGivenByStore(STUDIO_GIVE_JOB), isGivenByStore("api:key1"), isGivenByStore("gift:abc"), isGivenByStore("0123456789abcdef01234567")], [true, true, false, false]);
  // Pre-review of unit 2, light: the list's email said a store's gift was "brought over from another platform".
  is(
    "the list's email never says a store's gift was charged, nor brought over",
    [chargedLine("Giver Shop", [{ kind: "imported", givenByStore: true }]), chargedLine("Giver Shop", [{ kind: "sale" }, { kind: "imported", givenByStore: true }]), chargedLine("Giver Shop", [{ kind: "sale" }])],
    ["What Giver Shop gave you was not charged.", "Every purchase was charged by Giver Shop on their own Stripe account. What Giver Shop gave you was not charged.", "Every purchase was charged by Giver Shop on their own Stripe account."],
  );
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
  // cy opened Cake once (a row, which is no access: no sale, no gift); dee was taken off Cake; ben was brought over with Cake by an import.
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
  // Changed assertions (rule 23, pre-review of unit 2, MEDIO 3): cy was counted as "already studies it" (student: 1,
  // changes: 2) from the row alone, so the creator could not give the course to someone who had no access to it.
  is("the review says exactly what it would do", [review.status, review.body.review], [200, { changes: 3, already: 1, removed: 1, otherWay: 0, unread: 0 }]);
  is("and writes nothing", [await given("ana@example.com"), await given("zed@example.com")], [[], []]);
  // Changed (rule 23, MEDIO 3): expect 3 and changes 2, now 2 and 3.
  const stale = await post({ action: "apply", change: "give", to, emails: asked, expect: 2 });
  is("a count that is not the one reviewed is refused, with what it would do now, nothing written", [stale.status, stale.body.error, stale.body.review?.changes, await given("ana@example.com")], [409, "changed", 3, []]);
  const noCount = await post({ action: "apply", change: "give", to, emails: asked });
  is("a confirmation always carries the count it confirms", [noCount.status, noCount.body.error], [400, "expect"]);
  // Changed (rule 23, MEDIO 3): expect 2, changed [ana, zed] and student [cy]; cy is given it now, and no "student" is said.
  const applied = await post({ action: "apply", change: "give", to, emails: asked, expect: 3 });
  is(
    "given: each person's own result",
    [applied.status, applied.body.changed?.sort(), applied.body.already, applied.body.student, applied.body.removed, applied.body.unread, applied.body.unknown, applied.body.failed],
    [200, ["ana@example.com", "cy@example.com", "zed@example.com"], ["ben@example.com"], undefined, ["dee@example.com"], [], [], []],
  );
  store = (await storeForEmail(owner))!;
  is("written as the studio's gift, and the store reads its given courses", [await given("ana@example.com"), store.pastBuyers], [[STUDIO_GIVE_JOB], true]);
  is("cy, whose row gave no access, now opens it", (await paidCourses(store, "cy@example.com")).has(cake.product.id), true);
  is("the course opens for them, as one brought over does", [(await paidCourses(store, "ana@example.com")).has(cake.product.id), (await paidCourses(store, "zed@example.com")).has(cake.product.id)], [true, true]);
  is("ben keeps what the import gave him, untouched", await given("ben@example.com"), ["0123456789abcdef01234567"]);
  const created = (await redis.keys()).filter((key: string) => !keysBefore.has(key));
  is("no email, sequence or refund is started", created.filter((key: string) => /^nl:(mail|wf|ses|refund|outbox)/.test(key)), []);

  const backReview = await post({ action: "review", change: "takeback", to, emails: ["ana@example.com", "ben@example.com", "cy@example.com", "zed@example.com"] });
  // Changed (rule 23, MEDIO 3): changes 2 and student 0; cy was given it above.
  is("taking back: only what the studio gave; an import is not the studio's to take", backReview.body.review, { changes: 3, already: 0, removed: 0, otherWay: 1, unread: 0 });
  const undone = await post({ action: "apply", change: "takeback", to, emails: applied.body.changed, expect: applied.body.changed!.length });
  // Changed (rule 23, MEDIO 3): cy is among those given, so among those taken back.
  is("undone, exactly: those it gave no longer have it", [undone.status, undone.body.changed?.sort(), await given("ana@example.com"), await given("zed@example.com")], [200, ["ana@example.com", "cy@example.com", "zed@example.com"], [], []]);
  is("and the course no longer opens for them", (await paidCourses(store, "ana@example.com")).has(cake.product.id), false);
  is("ben's import is still there", await given("ben@example.com"), ["0123456789abcdef01234567"]);
  // "You can give it again right after": true even for who opened it while it was given (a row is left behind).
  await touchStudent(cakeCourse.id, "ana@example.com", now, ROOM);
  const againReview = await post({ action: "review", change: "give", to, emails: ["ana@example.com"] });
  is("taken back, it can be given again right after, even to who opened it meanwhile", againReview.body.review, { changes: 1, already: 0, removed: 0, otherWay: 0, unread: 0 });
  // Taken off the course with no row of theirs: giving it would not open it, so it is said, not given.
  await setBlocked(store, cakeCourse.id, "flo@example.com", true);
  const blockedReview = await post({ action: "review", change: "give", to, emails: ["flo@example.com"] });
  is("someone taken off it is left as they are, row or none", blockedReview.body.review, { changes: 0, already: 0, removed: 1, otherWay: 0, unread: 0 });

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
  // Changed (rule 23, MEDIO 3): no "student" count any more.
  is("a record that cannot be read is counted as unread, never as a change", unread.body.review, { changes: 0, already: 0, removed: 0, otherWay: 0, unread: 1 });
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

  const page = readFileSync("app/studio/students/page.tsx", "utf8");
  part("Who may give, and how many a day (pre-review of unit 2, ALTO 1)");
  // The finding: the gift needed only "products", which an editor has, while the API's gift needs "import" (owner and
  // admins: who owns what), and the addresses came from the body unchecked: an editor gave the course to two
  // addresses from outside and to himself, 200, changed 3.
  const editor = "ed@example.com";
  await putMember(store, editor, "editor");
  const edCookie = `${SESSION_COOKIE}=${await openSession(editor)}`;
  const outsiders = ["out1@example.net", "out2@example.net", editor];
  const byEditor = await post({ action: "apply", change: "give", to, emails: outsiders, expect: 3 }, { cookie: edCookie });
  const editorReview = await post({ action: "review", change: "give", to, emails: outsiders }, { cookie: edCookie });
  const editorBack = await post({ action: "review", change: "takeback", to, emails: outsiders }, { cookie: edCookie });
  is(
    "an editor may neither give a course nor take one back, nor see what it would do; nothing is given",
    [byEditor.status, editorReview.status, editorBack.status, await given("out1@example.net"), await given(editor)],
    [403, 403, 403, [], []],
  );
  const editorAccess = await post({ action: "review", change: "revoke", id: bread.product.id, emails: ["ana@example.com"] }, { cookie: edCookie });
  is("an editor still takes students off a course, as before", editorAccess.status, 200);
  const adminEmail = "ad@example.com";
  await putMember(store, adminEmail, "admin");
  const adminReview = await post({ action: "review", change: "give", to, emails: ["ana@example.com"] }, { cookie: `${SESSION_COOKIE}=${await openSession(adminEmail)}` });
  is("an admin may", [adminReview.status, adminReview.body.review?.changes], [200, 1]);
  is("the page offers the action only to whoever may give", page.includes('can(view.role, "import")'), true);

  // The store's gifts in a day are the API's (GIVES_PER_DAY, the same count), so neither way passes it.
  const dayKeys = async () => (await redis.keys()).filter((k: string) => k.startsWith("nl:rl:api-give:"));
  is("the gifts above were counted in the day", (await dayKeys()).length, 1);
  for (const key of await dayKeys()) await redisPipeline([["DEL", key]]);
  is("filled to one short of the day", await takeManyWithin("api-give", store.sid, GIVES_PER_DAY, DAY, GIVES_PER_DAY - 1), true);
  const pastDay = await post({ action: "apply", change: "give", to, emails: ["ana@example.com", "zed@example.com"], expect: 2 });
  is("past the store's gifts of the day: refused, nothing given", [pastDay.status, pastDay.body.error, await given("ana@example.com"), await given("zed@example.com")], [429, "daily_limit", [], []]);
  is("said plainly", GIVE_REFUSALS.daily_limit, "Nothing was given: that is as many as a store may give in a day, here and through the API together (1,000). Try again tomorrow.");
  const lastOne = await post({ action: "apply", change: "give", to, emails: ["ana@example.com"], expect: 1 });
  is("what is left of the day is given", [lastOne.status, lastOne.body.changed], [200, ["ana@example.com"]]);
  const dayUsed = await post({ action: "apply", change: "give", to, emails: ["zed@example.com"], expect: 1 });
  is("and then the day is used", [dayUsed.status, dayUsed.body.error, await given("zed@example.com")], [429, "daily_limit", []]);
  const backAfter = await post({ action: "apply", change: "takeback", to, emails: ["ana@example.com"], expect: 1 });
  is("taking back is never held by the day", [backAfter.status, backAfter.body.changed], [200, ["ana@example.com"]]);
  for (const key of await dayKeys()) await redisPipeline([["DEL", key]]);

  part("The store's data room given back (pre-review of unit 2, MEDIO 2)");
  // The finding: the room grantImported takes for a gift ("imp") was never given back when the studio took the gift
  // back (only HDEL), and was taken also for a gift HSETNX refused: three rounds with 50 people kept +72,000 bytes.
  store = (await storeForEmail(owner))!;
  const usedNow = async () => (await dataUsed(store))?.used ?? -1;
  const fifty = Array.from({ length: 50 }, (_, i) => `round${String(i).padStart(2, "0")}@example.org`);
  const before = await usedNow();
  for (let round = 0; round < 3; round += 1) {
    const gave = await applyGive(store, target, { change: "give", to, emails: fifty, expect: 50 }, async () => ({ ok: true }));
    const took = await applyGive(store, target, { change: "takeback", to, emails: fifty, expect: 50 }, async () => ({ ok: true }));
    if (gave.kind !== "done" || took.kind !== "done" || gave.done.changed.length !== 50 || took.done.changed.length !== 50) throw new Error(`round ${round} did not give and take back all fifty`);
  }
  is("three rounds of giving fifty people a course and taking it back leave the room as it was", (await usedNow()) - before, 0);
  for (const key of await dayKeys()) await redisPipeline([["DEL", key]]);
  await grantImported(store.statsId!, STUDIO_GIVE_JOB, [{ email: "once@example.org", productId: to, items: null }], now, store.sid, store);
  const once = await usedNow();
  const again = await grantImported(store.statsId!, STUDIO_GIVE_JOB, [{ email: "once@example.org", productId: to, items: null }], now, store.sid, store);
  is("a gift the record already holds (HSETNX refused) takes no room", [again, (await usedNow()) - once], [[false], 0]);
  await redisPipeline([["HDEL", importedKey(store.statsId!, "once@example.org"), to]]);
  // Taken back only while the record is still the one read: a grant written in between (here the API's) stays.
  await grantImported(store.statsId!, STUDIO_GIVE_JOB, [{ email: "cas@example.org", productId: to, items: null }], now, store.sid, store);
  const casKey = importedKey(store.statsId!, "cas@example.org");
  const sends = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && c[1] === TAKE_IF_SAME && c[3] === casKey)) await sends([["HSET", casKey, to, JSON.stringify({ at: now, job: "api:key9", items: null })]]);
    return sends(commands);
  };
  await takeGivenMany(store.statsId!, ["cas@example.org"], to, STUDIO_GIVE_PREFIX, store);
  redis.pipeline = sends;
  is("a gift rewritten between the read and the delete is never taken back", await given("cas@example.org"), ["api:key9"]);
  await redisPipeline([["HDEL", casKey, to]]);

  part("Light findings of the pre-review of unit 2");
  // The course was read (readListing) before the studio requests of the read were taken.
  const order: string[] = [];
  const finder = async () => (order.push("find"), target);
  const ask1 = { change: "give" as const, to, emails: ["ana@example.com"], expect: null };
  const refusedFind = await reviewGive(store, finder, ask1, async () => (order.push("pay"), { ok: false, reason: "used", message: "Used." }));
  is("refused its studio requests, the course is not even looked up", [refusedFind.kind, [...order]], ["refused", ["pay"]]);
  order.length = 0;
  const foundAfter = await reviewGive(store, finder, ask1, async () => (order.push("pay"), { ok: true }));
  is("the course is looked up only once its reads are paid for", [foundAfter.kind, [...order]], ["review", ["pay", "find"]]);
  const noCourse = await reviewGive(store, async () => null, ask1, async () => ({ ok: true }));
  is("a course that is not there, or cannot be given, is refused after paying", [noCourse.kind, noCourse.kind === "refused" ? noCourse.reason : ""], ["refused", "product"]);
  // Changed assertion (rule 23, this RED's own wording): it asked that "readListing(store, ask.to)" be gone from the
  // route; the route still reads the course, but only in the function the gift calls once the reads are paid for.
  is("the route reads the course only through the gift, once paid", readFileSync("app/api/store/students/route.ts", "utf8").includes("const target = async () => {\n    const product = await readListing(store, ask.to);"), true);

  // Another member's gift landing between the read and this write: its HSETNX answers 0, so it is not this one's.
  const rivalKey = importedKey(store.statsId!, "rival@example.org");
  const passes = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "HSETNX" && c[1] === rivalKey)) await passes([["HSET", rivalKey, to, JSON.stringify({ at: now - 5, job: STUDIO_GIVE_JOB, items: null })]]);
    return passes(commands);
  };
  const raced = await applyGive(store, target, { change: "give", to, emails: ["rival@example.org"], expect: 1 }, async () => ({ ok: true }));
  redis.pipeline = passes;
  is("a gift another member wrote first is never said as this one's", raced.kind === "done" ? [raced.done.changed, raced.done.already] : raced.kind, [[], ["rival@example.org"]]);
  await redisPipeline([["HDEL", rivalKey, to]]);

  // The creator's view of a person said a store's gift was "imported".
  await grantImported(store.statsId!, STUDIO_GIVE_JOB, [{ email: "seen@example.org", productId: to, items: null }], now, store.sid, store);
  const profile = await buyerProfile(store, "seen@example.org");
  is("the creator's view of a person says a store's gift is the store's", profile.orders.filter((o) => o.title === "Cake Course").map((o) => o.note), ["store"]);
  is("in plain words", readFileSync("app/studio/people/page.tsx", "utf8").includes('store: "Given by the store"'), true);
  await redisPipeline([["HDEL", importedKey(store.statsId!, "seen@example.org"), to]]);

  part("The day's gifts taken in one step (second pre-review of unit 2, MEDIO and LEVE 1)");
  // The finding: past the day, the DECRBY that put the take back went in a second request; when the 24-hour window
  // ended between the two, it made the key again with no end and below zero ("-25"), which the API reads as no count
  // (refused for good) and which never ends, so the count summed every day until it held the store's gifts for ever.
  const giftKeys = async () => (await redis.keys()).filter((k: string) => k.startsWith("nl:rl:api-give:"));
  for (const key of await giftKeys()) await redisPipeline([["DEL", key]]);
  const who = "second-review-store";
  is("990 of the day used", await takeManyWithin("api-give", who, GIVES_PER_DAY, DAY, 990), true);
  const relay = redis.pipeline.bind(redis);
  let sent = 0;
  redis.pipeline = async (commands: (string | number)[][]) => {
    const answer = await relay(commands);
    sent += 1;
    // The 24-hour window ends right after the first request: the key is gone, as Redis drops it when its time is up.
    if (sent === 1) for (const key of await giftKeys()) await relay([["DEL", key]]);
    return answer;
  };
  const late = await takeManyWithin("api-give", who, GIVES_PER_DAY, DAY, 25);
  redis.pipeline = relay;
  const leftOver = (await giftKeys()).map((key) => [redis.run(["GET", key]), redis.run(["TTL", key])]);
  is(
    "25 more past the day: refused in one request, and the window's end leaves no count without an end or below zero",
    [late, sent, leftOver.every(([value, ttl]) => Number(value) >= 0 && Number(ttl) > 0)],
    [false, 1, true],
  );
  is("the next day the store gives again, through the studio and through the API", [await takeManyWithin("api-give", who, GIVES_PER_DAY, DAY, 1), await withinLimit("api-give", who, GIVES_PER_DAY, DAY)], [true, true]);
  // A count the earlier code left below zero with no end is mended by the next take: never read as room, and it ends.
  const [stuck] = await giftKeys();
  redis.run(["SET", stuck, "-25"]);
  is("a count left below zero with no end is mended: counted from zero, with the day's end", [await takeManyWithin("api-give", who, GIVES_PER_DAY, DAY, 1), redis.run(["GET", stuck]), Number(redis.run(["TTL", stuck])) > 0], [true, "1", true]);
  for (const key of await giftKeys()) await redisPipeline([["DEL", key]]);
  // LEVE 1: the API asking between the take and its putting back was refused by a sum that never stood, and kept a place.
  is("990 used again", await takeManyWithin("api-give", who, GIVES_PER_DAY, DAY, 990), true);
  let apiBetween: boolean | null = null;
  sent = 0;
  redis.pipeline = async (commands: (string | number)[][]) => {
    const answer = await relay(commands);
    sent += 1;
    if (sent === 1) {
      redis.pipeline = relay;
      apiBetween = await withinLimit("api-give", who, GIVES_PER_DAY, DAY);
    }
    return answer;
  };
  const tooMany = await takeManyWithin("api-give", who, GIVES_PER_DAY, DAY, 25);
  redis.pipeline = relay;
  const [counted] = await giftKeys();
  is("the API asking right after a refused take is let through, and the count is the 990 and its one", [tooMany, apiBetween, redis.run(["GET", counted])], [false, true, "991"]);
  for (const key of await giftKeys()) await redisPipeline([["DEL", key]]);

  part("A day's gift given back when nothing was given (second pre-review of unit 2, LEVE 2)");
  const dayCount = async () => {
    const keys = await giftKeys();
    return keys.length ? Number(redis.run(["GET", keys[0]])) : 0;
  };
  // A store whose data room is full after the day was taken: nothing given, the day given back.
  const fullRoom = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: (string | number)[][]) =>
    commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:store-data:")
      ? [[0, 5]]
      : fullRoom(commands);
  const fullGive = await applyGive(store, target, { change: "give", to, emails: ["full1@example.org", "full2@example.org"], expect: 2 }, async () => ({ ok: true }));
  redis.pipeline = fullRoom;
  is("a full data room: refused, and the day's two given back", [fullGive.kind === "refused" ? fullGive.reason : fullGive.kind, await dayCount()], ["store_full", 0]);
  // Two clicks at once: the second one's write finds the first's gift (HSETNX answers 0), so it gives nothing and keeps nothing of the day.
  const twinKey = importedKey(store.statsId!, "twin@example.org");
  const twin = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "HSETNX" && c[1] === twinKey)) await twin([["HSET", twinKey, to, JSON.stringify({ at: now, job: STUDIO_GIVE_JOB, items: null })]]);
    return twin(commands);
  };
  const second = await applyGive(store, target, { change: "give", to, emails: ["twin@example.org", "solo@example.org"], expect: 2 }, async () => ({ ok: true }));
  redis.pipeline = twin;
  // Changed assertion (rule 23, coordinator on the second pre-review, LEVE 2): only an HSETNX answered exactly 0 may give
  // the day back, and grantImported says false for that 0 and for an unknown answer alike, so the day stays taken for
  // both until it hands over its exact answers (lib/imported-purchases.ts, held for #2576).
  is("the click whose write found the gift already there is said as already given; the day stays taken (its 0 is not seen exactly)", [second.kind === "done" ? [second.done.changed, second.done.already] : second.kind, await dayCount()], [[["solo@example.org"], ["twin@example.org"]], 2]);
  await redisPipeline([["HDEL", twinKey, to], ["HDEL", importedKey(store.statsId!, "solo@example.org"), to]]);
  for (const key of await giftKeys()) await redisPipeline([["DEL", key]]);
  // An HSETNX answered in no known shape (neither 0 nor 1) may have written: the day stays taken (unknown fails closed).
  const oddKey = importedKey(store.statsId!, "odd@example.org");
  const odd = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: (string | number)[][]) => {
    const answers = await odd(commands);
    const at = commands.findIndex((c) => c[0] === "HSETNX" && c[1] === oddKey);
    return at < 0 ? answers : answers.map((a: unknown, i: number) => (i === at ? null : a));
  };
  const oddGive = await applyGive(store, target, { change: "give", to, emails: ["odd@example.org"], expect: 1 }, async () => ({ ok: true }));
  redis.pipeline = odd;
  is("an HSETNX answer that is neither 0 nor 1 keeps the day's gift taken", [oddGive.kind, await dayCount()], ["done", 1]);
  await redisPipeline([["HDEL", oddKey, to]]);
  for (const key of await giftKeys()) await redisPipeline([["DEL", key]]);

  part("The day's gifts said as one count (second pre-review of unit 2, LEVE 3 and LEVE 4)");
  is("the studio's refusal names the day's figure from GIVES_PER_DAY, never a number typed in", readFileSync("lib/student-bulk-rules.ts", "utf8").includes("(1,000)"), false);
  is("the API's refusal of a gift says gifts, and that the studio's count too", (apiWrite as Record<string, unknown>).GIFTS_USED_WORDS, "That is as many products as a store may give in a day, through the API and the studio's list of students together (1,000). Try again tomorrow.");
  is(
    "the developers page says the studio's gifts count in the same day",
    readFileSync("app/developers/page.tsx", "utf8").includes("products a day, through the API and the studio's list of students together"),
    true,
  );
  is("the review says whether they bought it is not checked", giveReviewLines({ changes: 1, already: 0, removed: 0, otherWay: 0, unread: 0 }, "give", "Cake Course").includes(String((bulkRules as Record<string, unknown>).BOUGHT_NOT_CHECKED)), true);

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
  is("the page filters by when they were last here and offers the other courses that can be given", [page.includes('name="seen"'), page.includes("givable(")], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
