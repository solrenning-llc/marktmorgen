/**
 * A person's deletion takes them off a course's list of people taken off it, `nl:course:<id>:blocked` (Claude 6 on
 * #4563): the hashed address (lib/learn.ts emailKey) the creator's "take off the course" writes (setBlocked) was never
 * removed by any erasure, live course or dropped, so it named the person after their deletion was answered done. Now
 * forgetLearnerPerson removes it with each course's other records, its reply read exactly (an SREM's 0 or 1, rule 24),
 * and a dropped course where the address is only on that list is still reached (lib/learn.ts learnerProbes).
 *
 * Synthetic: the in-memory Redis stand-in; no email or Stripe call leaves the process.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { erasePerson, erasureScope } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { emailKey, setBlocked } from "@/lib/learn";
import { dropCourse, readCourse } from "@/lib/course";
import { removeProduct, storeForEmail } from "@/lib/store";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const blockedKey = (courseId: string) => `nl:course:${courseId}:blocked`;
const blocked = (courseId: string, email: string) => redis.run(["SISMEMBER", blockedKey(courseId), emailKey(normaliseEmail(email))]);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_erasure_course_blocked_stand_in";
  process.env.RESEND_API_KEY = "re_test_erasure_course_blocked_stand_in";

  part("A student taken off a live course, then their deletion");
  redis.clear();
  let world = await makeWorld();
  let store = (await storeForEmail(OWNER))!;
  const tess = normaliseEmail("tess@example.com");
  await seedPerson(world, tess, null);
  await setBlocked(store, world.courseId, tess, true);
  await setBlocked(store, world.courseId, "other@example.com", true);
  is("she is on the course's taken-off list", blocked(world.courseId, tess), 1);
  let result = await erasePerson(store, tess, { kind: "person" });
  is("the deletion is done", result.ok, true);
  is("and she is no longer on that list", blocked(world.courseId, tess), 0);
  is("another person taken off the course stays on it", blocked(world.courseId, "other@example.com"), 1);

  part("An address taken off a live course that was never one of its students");
  redis.clear();
  world = await makeWorld();
  store = (await storeForEmail(OWNER))!;
  const una = normaliseEmail("una@example.com");
  await setBlocked(store, world.courseId, una, true);
  result = await erasePerson(store, una, { kind: "person" });
  is("the deletion is done", result.ok, true);
  is("and the address is no longer on the list", blocked(world.courseId, una), 0);

  part("A dropped course where the address is only on the taken-off list");
  redis.clear();
  world = await makeWorld();
  store = (await storeForEmail(OWNER))!;
  const vic = normaliseEmail("vic@example.com");
  await setBlocked(store, world.courseId, vic, true);
  const course = (await readCourse(world.courseId))!;
  is("the product is removed", (await removeProduct(OWNER, world.courseProduct)).ok, true);
  store = (await storeForEmail(OWNER))!;
  await dropCourse(course, store, world.courseProduct);
  const scope = await erasureScope(store, vic);
  is("the deletion's scope reaches the dropped course", scope?.courses.map((c) => c.courseId), [world.courseId]);
  is("a stranger's does not", (await erasureScope(store, "wyn@example.com"))?.courses.length, 0);
  result = await erasePerson(store, vic, { kind: "person" });
  is("the deletion is done", result.ok, true);
  is("and the address is no longer on the dropped course's list", blocked(world.courseId, vic), 0);

  part("Rule 24: the list's removal not answered with a 0 or a 1 is never done");
  for (const reply of [null, "OK", 2, -1, "1"]) {
    redis.clear();
    world = await makeWorld();
    store = (await storeForEmail(OWNER))!;
    const xia = normaliseEmail("xia@example.com");
    await seedPerson(world, xia, null);
    await setBlocked(store, world.courseId, xia, true);
    redis.pipeline = async (commands: Command[]) => {
      const hit = (command: Command) => command[0] === "SREM" && String(command[1]).endsWith(":blocked");
      const replies = await real(commands.filter((command) => !hit(command)));
      let next = 0;
      return commands.map((command) => (hit(command) ? reply : replies[next++]));
    };
    try {
      result = await erasePerson(store, xia, { kind: "person" });
    } finally {
      redis.pipeline = real;
    }
    is(`an SREM answered ${JSON.stringify(reply)}: the deletion is not done`, result.ok, false);
    result = await erasePerson(store, xia, { kind: "person" });
    is(`asked again with exact replies: done, and she is off the list`, [result.ok, blocked(world.courseId, xia)], [true, 0]);
  }
  done();
}

void main();
