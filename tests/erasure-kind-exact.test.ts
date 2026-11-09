/**
 * A person's erasure reads every course product of the store exactly (rule 24;
 * lib/person-erasure.ts erasureScope, lib/catalog.ts readKindExact): a course
 * product past the catalog head whose listing record answers garbled is not
 * "no course", so the erasure never says done while that course's progress,
 * quizzes and certificates may stay stored. Without the fault, the scope has
 * the course and the erasure finishes.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductCourse, setSubscription, storeForEmail } from "@/lib/store";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { erasePerson, erasureScope } from "@/lib/person-erasure";
import { ROOM } from "./data-room";

const OWNER = "kinds@example.com";
const PERSON = "learner@example.com";

const fault = { key: "", on: false, gets: 0 };
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const reply = await pipeline(commands);
  if (!fault.on) return reply;
  return reply.map((answer, i) => {
    const command = commands[i];
    if (command[0] === "GET" && command[1] === fault.key) {
      fault.gets += 1;
      return 42;
    }
    if (command[0] === "MGET") {
      return Array.isArray(answer) ? answer.map((one, j) => (command[j + 1] === fault.key ? (fault.gets++, 42) : one)) : answer;
    }
    return answer;
  });
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_erasure_kind_exact_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_erasure_kind_exact_only_a_stand_in";
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

  await claimHandle(OWNER, "kinds-shop", "Kinds Shop", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const now = Math.floor(Date.now() / 1000);
  await setSubscription(OWNER, { customerId: "cus_KindsExact1", subscriptionId: "sub_KindsExact1", active: true, tier: "pro", period: { start: now - 10 * 86_400, end: now + 20 * 86_400, renews: true } });
  const ids: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    const added = await addProduct(OWNER, `Product ${i}`, "", "9", null);
    if (!added.ok) throw new Error(`no product ${i}: ${JSON.stringify(added)}`);
    ids.push(added.product.id);
  }
  let store = (await storeForEmail(OWNER))!;
  const head = new Set(store.catalog.head.map((listing) => listing.id));
  const off = ids.find((id) => !head.has(id));
  if (!off || store.catalog.inline) throw new Error("no product past the catalog head");

  let course = emptyCourse();
  const added = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "One" });
  if (!added.ok) throw new Error("no lesson");
  course = added.course;
  await saveCourse(course, ROOM);
  const set = await setProductCourse(OWNER, off, { id: course.id, lessons: 1 });
  if (!set.ok) throw new Error(`not a course: ${JSON.stringify(set)}`);
  store = (await storeForEmail(OWNER))!;
  is("the course product is still past the catalog head", store.catalog.head.some((listing) => listing.id === off), false);

  part("The course product's listing answers garbled: the scope is unknown, never without it");
  fault.key = `nl:catalog:${store.catalog.id}:l:${off}`;
  fault.on = true;
  fault.gets = 0;
  let threw = false;
  let scopeCourses: string[] | null = null;
  try {
    const scope = await erasureScope(store, PERSON);
    scopeCourses = scope ? scope.courses.map((c) => c.productId) : null;
  } catch {
    threw = true;
  }
  is("the garbled listing was read", fault.gets > 0, true);
  is("erasureScope throws rather than answer a scope without the course", threw, true);
  is("no scope was answered that leaves the course out", scopeCourses, null);
  fault.gets = 0;
  const faulted = await erasePerson(store, PERSON, { kind: "person" });
  is("the garbled listing was read by the erasure", fault.gets > 0, true);
  is("the erasure does not say done", faulted.ok, false);
  is("the erasure says the store could not be read", faulted.ok ? "ok" : faulted.reason, "unavailable");
  fault.on = false;

  part("Control: read whole, the scope has the course and the erasure finishes");
  const scope = await erasureScope(store, PERSON);
  is("the scope has the course product past the head", scope?.courses.map((c) => [c.productId, c.courseId]), [[off, course.id]]);
  const erased = await erasePerson(store, PERSON, { kind: "person" });
  is("the erasure finishes", erased.ok, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
