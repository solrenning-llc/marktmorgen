/**
 * A person's deletion while the store's course outlines read in another shape
 * (rule 24: an unknown or off-shape reply is never read as "no courses").
 *
 * Before: lib/course.ts readCourses read a reply that was not a list, or a
 * stored outline that would not parse, as "no such course", so
 * lib/person-erasure.ts erasureScope found no courses, the learner, quiz,
 * assignment, certificate and lesson-comment erasers had nothing to go
 * through, and the deletion answered done while the person's course records
 * were all still kept. Now the scope is read exactly (readCoursesExact): an
 * outline that is there but unreadable throws, the deletion answers
 * "unavailable" and deletes nothing, so pressing again finishes it; only an
 * outline Redis confirms is not there is left out.
 *
 * Synthetic: an in-memory Redis whose replies are bent, no email or Stripe call
 * leaves the process.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson, snapshot } from "./erasure-world";
import { erasePerson, erasureScope } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { emailKey } from "@/lib/learn";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** How the course outlines' MGET is answered: as it is, not a list, or one outline that is not JSON. */
let bend: "none" | "not-a-list" | "unparsable" | "short" = "none";
redis.pipeline = (async (commands: Command[]) => {
  const replies = await real(commands);
  commands.forEach((c, i) => {
    if (c[0] !== "MGET" || !String(c[1]).startsWith("nl:course:")) return;
    if (bend === "not-a-list") replies[i] = 7;
    if (bend === "unparsable") replies[i] = (replies[i] as unknown[]).map(() => "{not json");
    if (bend === "short") replies[i] = (replies[i] as unknown[]).slice(1);
  });
  return replies;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_erasure_course_unknown_stand_in";
  process.env.RESEND_API_KEY = "re_test_erasure_course_unknown_stand_in";
  const world = await makeWorld();
  const tess = normaliseEmail("tess@example.com");
  await seedPerson(world, tess, null);
  const learner = emailKey(tess);
  const courseRecords = async () =>
    [...(await snapshot())].filter(([k, v]) => (k.includes(world.courseId) || world.lessons.some((l) => k.includes(l))) && (k.includes(learner) || v.includes(learner) || k.includes(tess) || v.includes(tess))).length;

  part("Setup");
  const plain = await erasureScope(world.store, tess);
  is("the store has one course, and the person is in it", plain?.courses.length, 1);
  const kept = await courseRecords();
  is("several of their course records are kept", kept > 3, true);

  for (const how of ["not-a-list", "unparsable", "short"] as const) {
    part(`A deletion while the outlines read ${how}`);
    bend = how;
    const scope = await erasureScope(world.store, tess).then((s) => (s ? s.courses.length : "none"), () => "unknown");
    const result = await erasePerson(world.store, tess, { kind: "person" });
    bend = "none";
    is("the scope is unknown, never a store without courses", scope, "unknown");
    is("the deletion never answers done", [result.ok, result.ok ? "" : result.reason], [false, "unavailable"]);
    is("and nothing of their courses was taken on that guess, so pressing again finishes it", await courseRecords(), kept);
  }

  part("Pressed again once the outlines read");
  const again = await erasePerson(world.store, tess, { kind: "person" });
  is("done", again.ok, true);
  is("and none of their course records is kept", await courseRecords(), 0);

  part("A course Redis confirms is not there");
  await real([["DEL", `nl:course:${world.courseId}`]]);
  const gone = await erasureScope(world.store, tess);
  is("is left out of the scope, as before", gone?.courses.length, 0);
  is("and a deletion still finishes", (await erasePerson(world.store, tess, { kind: "person" })).ok, true);

  done();
}

void main();
