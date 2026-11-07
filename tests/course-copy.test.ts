/**
 * Copying one of a store's own courses into a new one (294 [SQ5], unit 1;
 * added 7 November 2026). Checked, in the in-memory Redis:
 *
 *   - the rules: every module and lesson gets a new id; titles, opening days,
 *     links, previews, text and the certificate setting come across; videos,
 *     downloads, quizzes, assignments and the start date do not, and are
 *     counted; the words say exactly that;
 *   - what it counts: the studio requests are worked out from the largest a
 *     listing, a course and a lesson's text may be, at a request's priced
 *     size, and the sentence the picker shows is made from the same figures;
 *   - the route: the copy is saved with its text, the other course is left
 *     exactly as it was, the product is hidden, its lesson count set, and the
 *     studio requests taken are exactly what the words say;
 *   - refused before anything is read: a course already changed, itself, a
 *     product of another store, the month's studio requests used (nothing of
 *     the other course is read); refused before anything is written when the
 *     second count is refused;
 *   - a write that fails halfway leaves nothing behind: the texts written go,
 *     the product goes back on the store, the course stays as it was made;
 *   - the picker and the editor: offered only on a new course with another
 *     course to copy, a labeled list, a live region, only the product id sent.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { type Course, MAX_BODY_LENGTH, emptyCourse, readBody, readCourse, saveBody, saveCourse } from "@/lib/course";
import {
  COPY_ABOUT,
  COPY_READ_UNITS,
  COPY_SAVE_UNITS,
  COPY_TEXT_UNITS,
  COURSE_RECORD_BYTES,
  LESSON_TEXT_BYTES,
  SOURCE_LISTING_BYTES,
  copiedWords,
  copyCostWords,
  copyCourse,
  copyLeftWords,
  copyUnits,
  copyWriteUnits,
  withTexts,
} from "@/lib/course-copy-rules";
import { COPY_UNIT_BYTES, COPY_UNIT_COMMANDS } from "@/lib/store-copy-rules";
import { MAX_PRODUCT_BYTES, readListing } from "@/lib/catalog";
import { BODY_BYTES, COURSE_BYTES } from "@/lib/api-read-rules";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceUsed, giveAllowance, takeAllowance } from "@/lib/store-allowance";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
/** A value as JSON with its keys in order, so two records equal in content compare equal. */
const canon = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v));

/** A course of two modules, as a creator would have made it, with everything a copy leaves out. */
function sourceCourse(id: string): Course {
  const file = (pathname: string) => ({ pathname, name: pathname.split("/").pop()!, bytes: 1000, contentType: "application/pdf", addedAt: "2026-10-01T00:00:00.000Z" });
  return {
    id,
    modules: [
      {
        id: "modaaaaaaaa1",
        title: "Your starter",
        dripDays: 0,
        lessons: [
          { id: "lesaaaaaaaa1", title: "Flour and water", preview: true, video: { ...file("s/lesaaaaaaaa1/intro.mp4"), contentType: "video/mp4" }, files: [file("s/lesaaaaaaaa1/sheet.pdf")], link: "https://example.com/flour", hasBody: true, quiz: null },
          { id: "lesaaaaaaaa2", title: "Feeding", preview: false, video: null, files: [], link: null, hasBody: true, quiz: { questions: 3, passPercent: 70, attempts: 0, required: false } },
        ],
      },
      {
        id: "modaaaaaaaa2",
        title: "Your first loaf",
        dripDays: 7,
        lessons: [
          { id: "lesaaaaaaaa3", title: "Shaping", preview: false, video: null, files: [file("s/lesaaaaaaaa3/a.pdf"), file("s/lesaaaaaaaa3/b.pdf")], link: null, hasBody: false, quiz: null, task: { files: false } as never },
          { id: "lesaaaaaaaa4", title: "Baking", preview: false, video: null, files: [], link: null, hasBody: true, quiz: null },
        ],
      },
    ],
    certificate: true,
    certificateMonths: 24,
    stampVideo: true,
    startsAt: 1_790_000_000,
  };
}

async function main(): Promise<void> {
  part("The rules");
  let n = 0;
  const ids = () => `newid${String(n++).padStart(7, "0")}`;
  const source = sourceCourse("a".repeat(32));
  const copy = copyCourse(source, { id: "b".repeat(32) }, ids);
  const lessons = copy.course.modules.flatMap((m) => m.lessons);
  const oldIds = new Set([...source.modules.map((m) => m.id), ...source.modules.flatMap((m) => m.lessons.map((l) => l.id))]);
  const newIds = [...copy.course.modules.map((m) => m.id), ...lessons.map((l) => l.id)];
  is("the copy is the new course: its own id", copy.course.id, "b".repeat(32));
  is("every module and lesson has a new id, none of the other course's, none twice", [newIds.some((id) => oldIds.has(id)), new Set(newIds).size, newIds.length], [false, 6, 6]);
  is("modules: titles and opening days kept, in order", copy.course.modules.map((m) => [m.title, m.dripDays]), [["Your starter", 0], ["Your first loaf", 7]]);
  is("lessons: titles, previews, links and text kept, in order", lessons.map((l) => [l.title, l.preview, l.link, l.hasBody]), [
    ["Flour and water", true, "https://example.com/flour", true],
    ["Feeding", false, null, true],
    ["Shaping", false, null, false],
    ["Baking", false, null, true],
  ]);
  is("no video, download, quiz or assignment comes across", lessons.map((l) => [l.video, l.files.length, l.quiz, "task" in l]), [[null, 0, null, false], [null, 0, null, false], [null, 0, null, false], [null, 0, null, false]]);
  is("the settings come across, the start date does not", [copy.course.certificate, copy.course.certificateMonths, copy.course.stampVideo, copy.course.startsAt], [true, 24, true, null]);
  is("what is left out is counted", copy.left, { videos: 1, files: 3, quizzes: 1, assignments: 1, start: true });
  is("each lesson with text is paired with its copy", copy.texts, [
    { from: "lesaaaaaaaa1", to: lessons[0].id },
    { from: "lesaaaaaaaa2", to: lessons[1].id },
    { from: "lesaaaaaaaa4", to: lessons[3].id },
  ]);
  is("the other course is not changed by the copy", JSON.stringify(source), JSON.stringify(sourceCourse("a".repeat(32))));
  let repeated = 0;
  const twice = copyCourse(source, { id: "c".repeat(32) }, () => `rep${String(Math.floor(repeated++ / 2)).padStart(9, "0")}`);
  const twiceIds = [...twice.course.modules.map((m) => m.id), ...twice.course.modules.flatMap((m) => m.lessons.map((l) => l.id))];
  is("an id drawn twice is drawn again", new Set(twiceIds).size, twiceIds.length);
  const plain = copyCourse({ ...emptyCourse("d".repeat(32)), certificate: false }, { id: "e".repeat(32) });
  is("a plain course: no certificate months or video stamp made up, nothing left out", [Object.keys(plain.course).sort(), plain.left, plain.texts], [["certificate", "id", "modules", "startsAt"], { videos: 0, files: 0, quizzes: 0, assignments: 0, start: false }, []]);
  const marked = withTexts(copy.course, new Set([lessons[0].id]));
  is("a lesson whose text turned out empty is marked as having none", marked.modules.flatMap((m) => m.lessons.map((l) => l.hasBody)), [true, false, false, false]);

  part("The words");
  is("what is left out, said once each", copyLeftWords(copy.left), [
    "Not copied: 1 video, 3 downloads, 1 quiz and 1 assignment. Open each lesson and add them again.",
    'The start date was not copied. Set one under "The day this course begins" if this group starts on a set day.',
  ]);
  is("one thing left out", copyLeftWords({ videos: 2, files: 0, quizzes: 0, assignments: 0, start: false }), ["Not copied: 2 videos. Open each lesson and add them again."]);
  is("nothing left out: nothing said", copyLeftWords(plain.left), []);
  is("once saved: what was copied, that it is hidden, and what was left out", copiedWords(copy).startsWith("Copied 2 modules and 4 lessons. The course stays hidden from your store until you publish it. Not copied: 1 video,"), true);
  is("the start-date words name the editor's own heading", read("components/course-editor.tsx").includes("The day this course begins"), true);
  is("before copying: what comes across and what never does", [COPY_ABOUT.includes("It does not copy videos, downloads, quizzes, assignments or the start date."), COPY_ABOUT.includes("It never copies students, their progress, notes or comments.")], [true, true]);

  part("What it counts");
  is("the largest listing, course and lesson text are the server's own", [SOURCE_LISTING_BYTES, COURSE_RECORD_BYTES, LESSON_TEXT_BYTES], [MAX_PRODUCT_BYTES, COURSE_BYTES, BODY_BYTES]);
  is("a unit is no larger than a priced studio request (twenty commands, fifty kilobytes: tests/plan-cost-registry.ts)", [COPY_UNIT_COMMANDS <= 20, COPY_UNIT_BYTES <= 50_000], [true, true]);
  is("reading the other course: its listing and record at their largest", COPY_READ_UNITS, Math.ceil((MAX_PRODUCT_BYTES + COURSE_BYTES) / COPY_UNIT_BYTES));
  is("saving the copy's record at its largest", COPY_SAVE_UNITS, Math.ceil(COURSE_BYTES / COPY_UNIT_BYTES));
  is("each lesson's text read and written at its largest", COPY_TEXT_UNITS, Math.ceil((BODY_BYTES * 2) / COPY_UNIT_BYTES));
  is("so many lessons, so many more; never fewer than nothing", [copyWriteUnits(0), copyWriteUnits(3), copyWriteUnits(-1), copyWriteUnits(1.5)], [COPY_SAVE_UNITS, COPY_SAVE_UNITS + 3 * COPY_TEXT_UNITS, COPY_SAVE_UNITS, COPY_SAVE_UNITS]);
  is("the sentence is made from the same figures", copyCostWords(), `Copying counts as ${COPY_READ_UNITS + COPY_SAVE_UNITS} of your studio requests, and ${COPY_TEXT_UNITS} more for each lesson that has text.`);
  is("a full course of 200 lessons with text, the most one can be, fits in the smallest paid plan's month", copyUnits(200) < 2_000, true);
  is("a lesson's text is no longer than the course keeps", LESSON_TEXT_BYTES, MAX_BODY_LENGTH * 3);

  part("Copied by the route");
  const owner = "baker@example.com";
  await claimHandle(owner, "bakerycopy", "Bakery", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Copyxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_copy", subscriptionId: "sub_copy", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(owner);
  type Reply = { ok?: boolean; error?: string; message?: string; hidden?: boolean; units?: number; words?: string; course?: Course };
  const post = async (body: Record<string, unknown>, who = session) => {
    const response = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${who}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const me = async () => (await storeForEmail(owner))!;
  const used = async () => allowanceUsed(await me(), "studio");

  const old = await addProduct(owner, "Sourdough at Home", "", "40");
  const oldId = old.ok ? old.product.id : "";
  await post({ action: "enable", id: oldId });
  const oldCourseId = (await readListing(await me(), oldId))!.course!.id;
  await saveCourse(sourceCourse(oldCourseId), await me());
  await saveBody(oldCourseId, "lesaaaaaaaa1", "Mix equal weights of flour and water.", await me());
  await saveBody(oldCourseId, "lesaaaaaaaa2", "Feed it every day.", await me());
  // Marked as having text, but none was ever kept: copied as a lesson without text.
  const keptBefore = JSON.stringify(await readCourse(oldCourseId));

  const fresh = await addProduct(owner, "Sourdough, spring group", "", "40");
  const newId = fresh.ok ? fresh.product.id : "";
  await post({ action: "enable", id: newId });
  const listing = async () => (await readListing(await me(), newId))!;
  const newCourseId = (await listing()).course!.id;
  is("the new course is on the store before the copy", (await listing()).hidden, false);

  let sourceReads = 0;
  let textReads = 0;
  let failTextWrites = 0;
  const textKeys = new Set<string>();
  const pipeline = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof pipeline }).pipeline = async (cmds) => {
    for (const c of cmds) {
      const [verb, key] = [String(c[0]).toUpperCase(), String(c[1] ?? "")];
      if (verb === "GET" && key === `nl:course:${oldCourseId}`) sourceReads += 1;
      if (verb === "MGET" && cmds.some((cmd) => cmd.slice(1).some((k) => String(k).startsWith(`nl:course:${oldCourseId}:body:`)))) textReads += 1;
      if (verb === "SET" && key.startsWith(`nl:course:${newCourseId}:body:`)) {
        if (failTextWrites > 0) {
          failTextWrites -= 1;
          if (failTextWrites === 0) throw new Error("the database did not answer");
        }
        textKeys.add(key);
      }
    }
    return pipeline(cmds);
  };

  part("Refused before anything is read");
  const before = await used();
  const itself = await post({ action: "copy", id: newId, from: newId });
  is("itself: refused, only the request counted, nothing read", [itself.status, itself.body.error, (await used()) - before, sourceReads], [400, "same", 1, 0]);
  const nothing = await post({ action: "copy", id: newId, from: "" });
  is("no course named: refused", [nothing.status, nothing.body.error], [400, "unknown"]);
  const strangerEmail = "stranger@example.com";
  await claimHandle(strangerEmail, "strangerstore", "Stranger", "");
  await ensureStatsId(strangerEmail);
  await ensureStoreId(strangerEmail);
  await setSubscription(strangerEmail, { customerId: "cus_str", subscriptionId: "sub_str", active: true, tier: "creator", period: paidPeriod() });
  const theirs = await addProduct(strangerEmail, "Their course", "", "10");
  const theirsId = theirs.ok ? theirs.product.id : "";
  const strangerSession = await openSession(strangerEmail);
  await post({ action: "enable", id: theirsId }, strangerSession);
  const across = await post({ action: "copy", id: theirsId, from: oldId }, strangerSession);
  is("another store's course cannot be named: not found in the asking store, nothing of it read", [across.status, across.body.error, sourceReads], [404, "unknown", 0]);
  const plainProduct = await addProduct(owner, "A Loaf Tin", "", "20");
  const tin = await post({ action: "copy", id: newId, from: plainProduct.ok ? plainProduct.product.id : "" });
  is("a product that is not a course: refused", [tin.status, tin.body.error], [400, "not_course"]);

  const limit = allowanceFor(await me(), "studio");
  const spent = await used();
  // All but the request's own and a few: too few for the read.
  const heldRead = limit - spent - 1 - (COPY_READ_UNITS - 1);
  await takeAllowance(await me(), "studio", heldRead);
  const shortRead = await post({ action: "copy", id: newId, from: oldId });
  is("the month's studio requests too few to read: refused with the plan's words, nothing read or written", [shortRead.status, shortRead.body.error, typeof shortRead.body.message === "string" && shortRead.body.message.length > 0, sourceReads, (await readCourse(newCourseId))!.modules.map((m) => m.lessons.length), (await listing()).hidden], [429, "studio_used", true, 0, [0], false]);
  const pictured = read("components/course-copy-picker.tsx");
  is("the picker says the plan's sentence, and that nothing was copied", pictured.includes('answer.error === "studio_used" && answer.message ? `${answer.message} Nothing was copied.`'), true);

  part("Refused before anything is written");
  // Enough for the request and the read, not for the texts.
  await giveAllowance(await me(), "studio", heldRead);
  const heldWrite = limit - (await used()) - 1 - COPY_READ_UNITS - (copyWriteUnits(3) - 1);
  await takeAllowance(await me(), "studio", heldWrite);
  const usedThen = await used();
  const shortWrite = await post({ action: "copy", id: newId, from: oldId });
  is("too few for the texts: refused after the read, before any text is read or anything written", [shortWrite.status, shortWrite.body.error, sourceReads, textReads, (await readCourse(newCourseId))!.modules.map((m) => m.lessons.length), (await listing()).hidden], [429, "studio_used", 1, 0, [0], false]);
  is("only the request and the read were counted", (await used()) - usedThen, 1 + COPY_READ_UNITS);

  part("A write that fails halfway leaves nothing behind");
  await giveAllowance(await me(), "studio", heldWrite);
  failTextWrites = 2;
  const broken = await post({ action: "copy", id: newId, from: oldId });
  const keysLeft = (await redis.pipeline([...textKeys].map((key) => ["EXISTS", key]))).filter((n) => n === 1).length;
  is("the second text could not be written: refused, the first text taken away, the course as it was made, back on the store", [broken.status, broken.body.error, textKeys.size, keysLeft, (await readCourse(newCourseId))!.modules.map((m) => [m.title, m.lessons.length]), (await listing()).hidden], [500, "server_error", 1, 0, [["Module 1", 0]], false]);
  failTextWrites = 0;
  textKeys.clear();

  part("Copied");
  const usedNow = await used();
  const textsBefore = textReads;
  const copied = await post({ action: "copy", id: newId, from: oldId });
  const kept = (await readCourse(newCourseId))!;
  const keptLessons = kept.modules.flatMap((m) => m.lessons);
  is("answered with the course kept", [copied.status, copied.body.ok, canon(copied.body.course)], [200, true, canon(kept)]);
  is("the modules and lessons as the other course has them", [kept.modules.map((m) => [m.title, m.dripDays]), keptLessons.map((l) => [l.title, l.preview, l.link])], [
    [["Your starter", 0], ["Your first loaf", 7]],
    [["Flour and water", true, "https://example.com/flour"], ["Feeding", false, null], ["Shaping", false, null], ["Baking", false, null]],
  ]);
  is("their text, read in one command; a lesson marked with text that has none, without", [await readBody(newCourseId, keptLessons[0].id), await readBody(newCourseId, keptLessons[1].id), keptLessons.map((l) => l.hasBody), textReads - textsBefore], ["Mix equal weights of flour and water.", "Feed it every day.", [true, true, false, false], 1]);
  is("nothing left out came across", keptLessons.map((l) => [l.video, l.files.length, l.quiz, "task" in l]), [[null, 0, null, false], [null, 0, null, false], [null, 0, null, false], [null, 0, null, false]]);
  is("the settings, and no start date", [kept.certificate, kept.certificateMonths, kept.stampVideo, kept.startsAt], [true, 24, true, null]);
  is("the other course is exactly as it was, its text too", [JSON.stringify(await readCourse(oldCourseId)), await readBody(oldCourseId, "lesaaaaaaaa1")], [keptBefore, "Mix equal weights of flour and water."]);
  is("the product is hidden and counts its lessons", [(await listing()).hidden, copied.body.hidden, (await listing()).course!.lessons], [true, true, 4]);
  is("the studio requests counted: the request, then exactly what the words say for 3 lessons with text", [(await used()) - usedNow, copied.body.units], [1 + copyUnits(3), copyUnits(3)]);
  is("and said", copied.body.words, copiedWords({ course: kept, left: { videos: 1, files: 3, quizzes: 1, assignments: 1, start: true } }));
  const again = await post({ action: "copy", id: newId, from: oldId });
  is("a second copy into the same course: refused before anything is read, and nothing changes", [again.status, again.body.error, JSON.stringify(await readCourse(newCourseId))], [409, "not_new", JSON.stringify(kept)]);

  part("The picker, the editor and the page");
  const editor = read("components/course-editor.tsx");
  const page = read("app/studio/course/[product]/page.tsx");
  const route = read("app/api/store/course/route.ts");
  is("offered only on a new course, with another course to copy", editor.includes("copyFrom.length > 0 && templateFits(course).ok && templateFits(initial).ok") && editor.includes("<CourseCopyPicker"), true);
  is("a labeled list of the store's other courses, said before the button: what comes across, what it counts", [pictured.includes("<label htmlFor={`${id}-from`}"), pictured.includes("<select"), pictured.includes("{COPY_ABOUT}"), pictured.includes("{copyCostWords()}")], [true, true, true, true]);
  is("a refusal said in a live region", pictured.includes('role="status"'), true);
  is("only the other course's product id is sent", pictured.includes('JSON.stringify({ action: "copy", id: productId, from: chosen.id })'), true);
  is("the button names the course it copies, and the target is at least 44 pixels high", [pictured.includes("`Copy “${chosen.title}” into this course`"), pictured.includes("min-h-11")], [true, true]);
  is("after the copy, the focus moves to the first module's name", editor.includes("const first = kept.modules[0];"), true);
  is("the page reads the courses' names only for a new course, in the one command of the cards", page.includes("templateFits(course).ok ? idsOfKind(store, \"course\")") && page.includes("await readCards(store)"), true);
  is("the route copies under the course's lock, through lib/course-copy.ts", route.indexOf('if (action === "copy")') > route.indexOf("return await withLock(`nl:course:${courseInfo.id}:lock`"), true);
  done();
}

void main();
