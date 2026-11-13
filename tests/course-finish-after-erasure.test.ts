/**
 * Issue #4467 (Codex P, reproduced by Claude 2): a course finish that read every lesson done is paused at its claim;
 * the person's erasure completes in between. The stale claim must not recreate the finishing mark. Synthetic records.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { makeWorld, seedPerson, snapshot } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { emailKey, markLesson } from "@/lib/learn";
import { noteIfFinished, forgetFinishPerson } from "@/lib/course-finish";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_p_stand_in";
  process.env.RESEND_API_KEY = "re_test_p_stand_in";
  const world = await makeWorld();
  const tess = normaliseEmail("tess@example.com");
  await seedPerson(world, tess, null);
  const finKey = `nl:course:${world.courseId}:fin:${emailKey(tess)}`;
  const has = async () => [...(await snapshot())].some(([k]) => k === finKey);
  // every lesson done; the seeded finishing marker removed so the first finish is still to come
  for (const id of world.lessons) await markLesson(world.courseId, tess, id, true, ROOM);
  await redis.pipeline([["DEL", finKey]]);
  part("A finish that read all lessons done is paused at its SET, erasure runs, then it resumes");
  const real = redis.pipeline;
  let release: () => void = () => {};
  let reached: () => void = () => {};
  const hit = new Promise<void>((r) => (reached = r));
  const gate = new Promise<void>((r) => (release = r));
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if ((commands[0]?.[0] === "SET" && String(commands[0][1]).includes(":fin:")) || (commands[0]?.[0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:course-finish-claim:"))) {
      redis.pipeline = real;
      reached();
      await gate;
    }
    return real.call(redis, commands);
  }) as typeof redis.pipeline;
  const pending = noteIfFinished(world.store, world.courseProduct, world.courseId, tess);
  await hit;
  const result = await erasePerson(world.store, tess, { kind: "person" });
  is("erasure done", result.ok, true);
  release();
  const finished = await pending;
  is("the stale finish is refused", finished, false);
  is("the finishing marker stays absent", await has(), false);
  is("a second forget finds nothing", await forgetFinishPerson([world.courseId], tess), 0);
  part("Control: a new, not erased person finishes once");
  const ben = normaliseEmail("ben@example.com");
  for (const id of world.lessons) await markLesson(world.courseId, ben, id, true, ROOM);
  is("first finish claims", await noteIfFinished(world.store, world.courseProduct, world.courseId, ben), true);
  is("second finish refused", await noteIfFinished(world.store, world.courseProduct, world.courseId, ben), false);
  done();
}
void main();
