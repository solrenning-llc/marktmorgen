/**
 * 296 [SQ7], unit 1: lesson ratings through the real routes and the real
 * course-wide drop, against the in-memory Redis (second pre-review, L7):
 *
 *   - a student's "remove" with a pass opened for another course of the
 *     store is refused, and their rating stays; a pass for this course, or
 *     for every course, removes it;
 *   - a rating written while dropCourseRatings is between passes goes too,
 *     its room with it;
 *   - when the course's ratings cannot be confirmed gone, the product is not
 *     removed and the answer is "unavailable"; asked again, it goes, ratings
 *     and all;
 *   - what dropping a course's ratings sends, measured, stays within the
 *     worst case written beside the product removal (L1).
 */
import { NextRequest } from "next/server";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { POST as productRoute } from "@/app/api/store/product/route";
import { POST as ratingRoute } from "@/app/api/store/course/rating/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { MAX_LESSONS, lessonsInOrder, readCourse } from "@/lib/course";
import { mintPass, passCookieName } from "@/lib/learn";
import { emailKey } from "@/lib/learn";
import { readListing } from "@/lib/catalog";
import { DROP_LESSON_RATINGS, dropCourseRatings, rateLesson, readMyRating } from "@/lib/lesson-rating";
import { RATING_ROOM_BYTES } from "@/lib/lesson-rating-rules";
import { dataUsed } from "@/lib/store-data";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "sq7-routes@example.com";
const ANA = "ana@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "sqsevenroutes", "SQ7 Routes", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_Sq7Routes", true);
  await setSubscription(OWNER, { customerId: "cus_sq7_routes", subscriptionId: "sub_sq7_routes", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };
  const courseCall = async (body: Record<string, unknown>) => {
    const response = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers, body: JSON.stringify(body) }));
    return (await response.json()) as { ok?: boolean; error?: string };
  };
  const removeProduct = async (id: string) => {
    const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers, body: JSON.stringify({ action: "remove", id }) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const makeCourse = async (title: string) => {
    const made = await addProduct(OWNER, title, "", "40");
    if (!made.ok) throw new Error("product not made");
    const id = made.product.id;
    const enabled = await courseCall({ action: "enable", id });
    if (!enabled.ok) throw new Error(`course not enabled: ${enabled.error}`);
    const listing = await readListing((await storeForEmail(OWNER))!, id);
    if (!listing?.course) throw new Error("course not listed");
    const before = await readCourse(listing.course.id);
    const added = await courseCall({ action: "edit", id, op: "lesson-add", moduleId: before!.modules[0].id, title: "Lesson one" });
    if (!added.ok) throw new Error(`lesson not added: ${added.error}`);
    const lesson = lessonsInOrder((await readCourse(listing.course.id))!).at(-1)!.lesson.id;
    return { id, courseId: listing.course.id, lesson };
  };
  const removeRating = async (product: string, lesson: string, pass: string) => {
    const form = new FormData();
    form.set("handle", store.handle);
    form.set("product", product);
    form.set("lesson", lesson);
    form.set("action", "remove");
    const response = await ratingRoute(new NextRequest("https://marktmorgen.com/api/store/course/rating", { method: "POST", body: form, headers: { cookie: `${passCookieName(store)}=${pass}` } }));
    return { status: response.status, to: response.headers.get("location") ?? "" };
  };
  const ana = emailKey(ANA);

  part("A pass for one course never removes a rating in another course of the store");
  const first = await makeCourse("First course");
  const second = await makeCourse("Second course");
  await rateLesson({ room: store, courseId: second.courseId, lessonId: second.lesson, who: ana, score: 4, note: "Kept." });
  // The pass checkout opens with the address typed there (app/api/store/course/start): this course only.
  const narrow = await mintPass(store, ANA, [first.courseId]);
  const refused = await removeRating(second.id, second.lesson, narrow);
  is("refused: sent back to the course, nothing said removed", [refused.status, refused.to.includes("?r=removed")], [303, false]);
  is("her rating in the other course stays", (await readMyRating(second.courseId, second.lesson, ana))?.score, 4);
  const own = await mintPass(store, ANA, [second.courseId]);
  const removed = await removeRating(second.id, second.lesson, own);
  is("a pass for that course removes it", [removed.status, removed.to.includes("?r=removed"), await readMyRating(second.courseId, second.lesson, ana)], [303, true, null]);
  await rateLesson({ room: store, courseId: second.courseId, lessonId: second.lesson, who: ana, score: 2, note: "" });
  const all = await mintPass(store, ANA, "all");
  is("a pass for every course (a sign-in link) removes it too", [(await removeRating(second.id, second.lesson, all)).to.includes("?r=removed"), await readMyRating(second.courseId, second.lesson, ana)], [true, null]);

  part("A rating written between dropCourseRatings's passes goes too");
  const C = "c".repeat(32);
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;
  const baseline = await used();
  await rateLesson({ room: ROOM, courseId: C, lessonId: "lessonaaaa01", who: ana, score: 5, note: "" });
  const original = redis.pipeline.bind(redis);
  let slipped = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original(commands);
    // After the first pass's drop, and before the index is read again: a student's rating comes in.
    if (!slipped && commands.some((c) => c[0] === "EVAL" && c[1] === DROP_LESSON_RATINGS)) {
      slipped = true;
      redis.pipeline = original;
      await rateLesson({ room: ROOM, courseId: C, lessonId: "lessonbbbb02", who: emailKey("ben@example.com"), score: 3, note: "Late." });
      redis.pipeline = wrapped;
    }
    return replies;
  }) as typeof redis.pipeline;
  const wrapped = redis.pipeline;
  const dropped = await dropCourseRatings(C, ROOM);
  redis.pipeline = original;
  is("the rating written in between was there to drop", slipped, true);
  is("both went: the first pass's and the one written in between", dropped, 2);
  is("the index is empty", redis.run(["SCARD", `nl:lr:${C}:ls`]), 0);
  is("their room came back, the course's slot too", await used(), baseline);

  part("Ratings that cannot be confirmed gone keep the product, and say unavailable");
  const third = await makeCourse("Third course");
  await rateLesson({ room: store, courseId: third.courseId, lessonId: third.lesson, who: ana, score: 3, note: "" });
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SMEMBERS" && c[1] === `nl:lr:${third.courseId}:ls`)) return [];
    return original(commands);
  }) as typeof redis.pipeline;
  const failed = await removeProduct(third.id);
  redis.pipeline = original;
  is("the removal is refused as unavailable", [failed.status, failed.body.ok, failed.body.error], [503, false, "unavailable"]);
  is("the product is still there", Boolean(await readListing((await storeForEmail(OWNER))!, third.id)), true);
  is("and so is the rating", (await readMyRating(third.courseId, third.lesson, ana))?.score, 3);
  const again = await removeProduct(third.id);
  is("asked again, the product goes", [again.status, again.body.ok], [200, true]);
  is("with its ratings", [await readMyRating(third.courseId, third.lesson, ana), redis.run(["SCARD", `nl:lr:${third.courseId}:ls`])], [null, 0]);

  part("What dropping a course's ratings sends stays within the worst case written at the product removal");
  const M = "m".repeat(32);
  const lessons = Array.from({ length: MAX_LESSONS }, (_, i) => `l${String(i).padStart(11, "0")}`);
  for (const lesson of lessons) await rateLesson({ room: ROOM, courseId: M, lessonId: lesson, who: ana, score: 4, note: "" });
  // Regra 23: was one count of commands and bytes, held to 2 + MAX_LESSONS commands and to the mean bytes a command
  // times 4 + 3 * MAX_LESSONS; a pass is one script for every lesson now, its room given back inside it, so the reads
  // and the scripts are measured apart, each at its largest, and the worst case is four reads and three scripts.
  let reads = 0;
  let scripts = 0;
  let readBytes = 0;
  let scriptBytes = 0;
  redis.pipeline = (async (sent: (string | number)[][]) => {
    const replies = await original(sent);
    const size = Buffer.byteLength(JSON.stringify(sent)) + Buffer.byteLength(JSON.stringify(replies));
    if (sent.some((c) => c[0] === "SMEMBERS")) {
      reads += sent.length;
      readBytes = Math.max(readBytes, size);
    } else if (sent.some((c) => c[0] === "EVAL" && c[1] === DROP_LESSON_RATINGS)) {
      scripts += sent.length;
      scriptBytes = Math.max(scriptBytes, size);
    }
    return replies;
  }) as typeof redis.pipeline;
  is("a course with a rating on each of its MAX_LESSONS lessons: all go", await dropCourseRatings(M, ROOM), MAX_LESSONS);
  redis.pipeline = original;
  // One pass with nothing written in between: two reads of the index and one script for every lesson.
  is(`measured: ${reads} reads of at most ${readBytes} bytes, ${scripts} script of at most ${scriptBytes} bytes`, [reads, scripts], [2, 1]);
  // The worst case: three passes, each re-dropping every lesson, and a fourth read, each at the largest measured.
  const worstCommands = 4 + 3;
  const worstBytes = 4 * readBytes + 3 * scriptBytes;
  const route = readFileSync(join(process.cwd(), "app/api/store/product/route.ts"), "utf8");
  const written = route.match(/at most (\d+) commands and about (\d+) KB/);
  is("the product removal says the worst case it was measured at", Boolean(written), true);
  is("its commands are the four reads and three scripts", Number(written?.[1]), worstCommands);
  is(`its kilobytes cover the measured bytes (${worstBytes}) at that count`, Number(written?.[2]) * 1000 >= worstBytes, true);
  is("each rating's room is charged when written, not here", RATING_ROOM_BYTES > 0, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
