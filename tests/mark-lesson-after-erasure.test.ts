/**
 * Issue #4435 (Codex L, reproduced by Claude 2): a mark-done request is let in and takes its room; an erasure of that
 * learner completes before its write. The late write must not bring a completed lesson back, and gives back its room;
 * a learner not deleted is marked as before, and undo still works. Synthetic records.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { doneLessons, markLesson } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const world = await makeWorld();
  const tess = normaliseEmail("tess-4435@example.com");
  const sam = normaliseEmail("sam-4435@example.com");
  await seedPerson(world, tess, null);
  // The seeded learner has the first lesson done already: the race is on the second.
  const [first, second] = world.lessons;
  const erased = { listId: world.store.listId ?? null };
  const used = async () => (await dataUsed(world.store))?.used ?? -1;

  part("A completion let in before an erasure, written after it, brings nothing back (issue #4435)");
  is("the store has a list to check", typeof erased.listId, "string");
  const realPipeline = redis.pipeline.bind(redis);
  let ran: Promise<unknown> | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const writes = commands.some((c) => (c[0] === "SADD" && String(c[1]).includes(":done:")) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:mark-done:")));
    if (writes && !ran) {
      redis.pipeline = realPipeline;
      ran = erasePerson(world.store, tess, { kind: "person" });
      is("the erasure completes", ((await ran) as { ok: boolean }).ok, true);
    }
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  await markLesson(world.courseId, tess, second, true, world.store, false, erased);
  redis.pipeline = realPipeline;
  is("the erasure ran while the request waited", ran !== null, true);
  is("the erased learner has no completed lesson afterward", [...(await doneLessons(world.courseId, tess))], []);

  part("After it, a quiz pass or a press writes nothing, and gives its room back whole");
  const room = await used();
  await markLesson(world.courseId, tess, first, true, world.store, true, erased);
  is("nothing written", [...(await doneLessons(world.courseId, tess))], []);
  is("the room is as it was", await used(), room);

  part("A learner not deleted is marked as before, and undo still works");
  await markLesson(world.courseId, sam, second, true, world.store, false, erased);
  is("marked", [...(await doneLessons(world.courseId, sam))], [second]);
  await markLesson(world.courseId, sam, second, false, world.store, false, erased);
  is("unmarked", [...(await doneLessons(world.courseId, sam))], []);

  part("A store with no list cannot tell who was deleted: nothing is written");
  await markLesson(world.courseId, sam, first, true, world.store, false, { listId: null });
  is("nothing written", [...(await doneLessons(world.courseId, sam))], []);

  done();
}

void main();
