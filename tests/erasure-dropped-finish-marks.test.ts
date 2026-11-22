/**
 * A person's erasure reaches their start and finish marks in a dropped course (#4542, Claude 1 cloud R's LEVE and its
 * RED test, kept as written; the finish mark, written the same way, added).
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { OWNER, makeWorld } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { emailKey } from "@/lib/learn";
import { noteIfOpened } from "@/lib/course-finish";
const FINISH_KEEP_SECONDS = 400 * 86_400;
import { dropCourse, readCourse } from "@/lib/course";
import { removeProduct, storeForEmail } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_red_4542_stand_in";
  process.env.RESEND_API_KEY = "re_test_red_4542_stand_in";
  part("Opened a course with no student row written, then the course product removed");
  redis.clear();
  const world = await makeWorld();
  const wren = normaliseEmail("wren@example.com");
  let store = (await storeForEmail(OWNER))!;
  is("the opening is noted", await noteIfOpened(store, world.courseProduct, world.courseId, wren), true);
  const key = `nl:course:${world.courseId}:open:${emailKey(wren)}`;
  const course = (await readCourse(world.courseId))!;
  is("the product is removed", (await removeProduct(OWNER, world.courseProduct)).ok, true);
  store = (await storeForEmail(OWNER))!;
  await dropCourse(course, store, world.courseProduct);
  const result = await erasePerson(store, wren, { kind: "person" });
  is("the deletion answers done", result.ok, true);
  const [left] = (await redisPipeline([["EXISTS", key]])) as unknown as [number | { result: number }];
  is("and their opened mark in the dropped course is gone", typeof left === "number" ? left : left.result, 0);

  part("Finished a course with no student row written, then the course product removed");
  redis.clear();
  const world2 = await makeWorld();
  const ivy = normaliseEmail("ivy@example.com");
  // The mark lib/course-finish.ts noteIfFinished writes once every lesson is done, written as it writes it.
  const finKey = `nl:course:${world2.courseId}:fin:${emailKey(ivy)}`;
  await redisPipeline([["SET", finKey, "1", "NX", "EX", FINISH_KEEP_SECONDS]]);
  is("the finish is noted", (await redisPipeline([["EXISTS", finKey]]))[0], 1);
  const course2 = (await readCourse(world2.courseId))!;
  is("the product is removed", (await removeProduct(OWNER, world2.courseProduct)).ok, true);
  const store2 = (await storeForEmail(OWNER))!;
  await dropCourse(course2, store2, world2.courseProduct);
  is("the deletion answers done", (await erasePerson(store2, ivy, { kind: "person" })).ok, true);
  const [finLeft] = (await redisPipeline([["EXISTS", finKey]])) as unknown as [number | { result: number }];
  is("and their finish mark in the dropped course is gone", typeof finLeft === "number" ? finLeft : finLeft.result, 0);
  done();
}

void main();
