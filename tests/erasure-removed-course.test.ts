/**
 * A person's deletion reaches the records of a course the store has since removed or turned off (C7 courses hunt).
 *
 * Before: lib/person-erasure.ts erasureScope listed only the courses the store's products hold now. Removing a course
 * product (app/api/store/product/route.ts) or turning its course off (app/api/store/course/route.ts, "disable") drops
 * the outline (lib/course.ts dropCourse) but leaves every per-person record of it: the student row with the plain
 * address, the lessons done, the quiz tries and results, the passes, the finish marks and the certificate, with the
 * person's name and address, still verifiable on the store's certificate page. The deletion then answered done with all
 * of them kept. Now a dropped course is noted first (its id, lessons and modules; lib/removed-courses.ts) and the
 * scope reaches it.
 *
 * Synthetic: the in-memory Redis stand-in; no email or Stripe call leaves the process.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { OWNER, makeWorld, seedPerson, snapshot } from "./erasure-world";
import { erasePerson, erasureScope } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { emailKey } from "@/lib/learn";
import { dropCourse, readCourse } from "@/lib/course";
import { removeProduct, storeForEmail } from "@/lib/store";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_erasure_removed_course_stand_in";
  process.env.RESEND_API_KEY = "re_test_erasure_removed_course_stand_in";

  for (const how of ["product removed"] as const) {
    part(`A course whose ${how}, then the person's deletion`);
    redis.clear();
    const world = await makeWorld();
    const tess = normaliseEmail("tess@example.com");
    await seedPerson(world, tess, null);
    const learner = emailKey(tess);
    // Every record about the course that names this person, by key or value.
    const courseRecords = async () =>
      [...(await snapshot())]
        .filter(([k, v]) => k.includes(world.courseId) || v.includes(world.courseId))
        .filter(([k, v]) => k.includes(learner) || v.includes(learner) || k.includes(tess) || v.includes(tess)).length;
    const kept = await courseRecords();
    is("their course records are kept, a certificate among them", kept > 3, true);

    const course = (await readCourse(world.courseId))!;
    const removed = await removeProduct(OWNER, world.courseProduct);
    is("the product is removed", removed.ok, true);
    const store = (await storeForEmail(OWNER))!;
    await dropCourse(course, store, world.courseProduct);
    is("the outline is gone", await readCourse(world.courseId), null);

    const scope = await erasureScope(store, tess);
    is("the deletion's scope still reaches the dropped course", scope?.courses.map((c) => c.courseId), [world.courseId]);
    const result = await erasePerson(store, tess, { kind: "person" });
    is("the deletion is done", result.ok, true);
    is("and none of their records of that course is kept", await courseRecords(), 0);
  }

  part("Many dropped courses: one person's erasure takes only those holding a record of theirs");
  redis.clear();
  const world = await makeWorld();
  const una = normaliseEmail("una@example.com");
  await seedPerson(world, una, null);
  const course = (await readCourse(world.courseId))!;
  const store = (await storeForEmail(OWNER))!;
  // Forty other courses the store made and dropped, where she never set foot.
  for (let i = 0; i < 40; i += 1) await dropCourse({ ...course, id: i.toString(16).padStart(32, "a") }, store, "");
  await dropCourse(course, store, world.courseProduct);
  const stranger = await erasureScope(store, "vic@example.com");
  is("somebody with no record in any: none of the dropped courses is taken", stranger?.courses.length, 0);
  is("though all forty-one were looked at", stranger?.droppedCourses, 41);
  const hers = await erasureScope(store, una);
  is("she has a record in one: only that one", hers?.courses.map((c) => c.courseId), [world.courseId]);

  part("A reached-share mark can be the only entry for a dropped course");
  redis.clear();
  const progressWorld = await makeWorld();
  const progressStore = (await storeForEmail(OWNER))!;
  const progressEmail = "reach-only@example.com";
  const finishedEmail = "reach-and-finish@example.com";
  const progressCourse = (await readCourse(progressWorld.courseId))!;
  const mark = `nl:course:${progressWorld.courseId}:reach:${emailKey(progressEmail)}`;
  const finishedLearner = emailKey(finishedEmail);
  const finishedMark = `nl:course:${progressWorld.courseId}:fin:${finishedLearner}`;
  const finishedProgressMark = `nl:course:${progressWorld.courseId}:reach:${finishedLearner}`;
  await redis.pipeline([["SET", mark, "50"], ["SET", finishedMark, "1"], ["SET", finishedProgressMark, "100"]]);
  await dropCourse(progressCourse, progressStore, "");
  const progressScope = await erasureScope(progressStore, progressEmail);
  is("the progress-only course is in the erasure scope", progressScope?.courses.map((c) => c.courseId), [progressWorld.courseId]);
  const progressErased = await erasePerson(progressStore, progressEmail, { kind: "person" });
  is("a successful erasure leaves no progress mark", [progressErased.ok, (await redis.pipeline([["GET", mark]]))[0]], [true, null]);
  const finishedErased = await erasePerson(progressStore, finishedEmail, { kind: "person" });
  const finishedMarks = await redis.pipeline([["GET", finishedMark], ["GET", finishedProgressMark]]);
  is("erasure leaves neither mark when both were present", [finishedErased.ok, finishedMarks], [true, [null, null]]);
  done();
}

void main();
