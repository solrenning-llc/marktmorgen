/**
 * Issue #4385: a note about a buyer (the team's page or a sequence's note step) takes its room and then writes; an
 * erasure of that buyer completes in between. The late write must not bring a note back, and gives back the room it
 * took; a buyer who was not deleted is noted as before; their own yes again lets them be noted again. The fence is the
 * store's suppression print the erasure already writes, so nothing new about them is kept. Synthetic records.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { addPersonNote, readPersonNotes } from "@/lib/buyer-profile";
import { upsertContact } from "@/lib/contacts";
import { personKey } from "@/lib/person-key";
import { dataUsed } from "@/lib/store-data";
import { redisPipeline } from "@/lib/redis";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

/** Runs `between` once, just before the first batch that writes a note about `person` reaches the store. */
function beforeTheWrite(statsId: string, person: string, between: () => Promise<unknown>): () => boolean {
  const notes = `nl:person:${statsId}:n:${person}`;
  const pipeline = redis.pipeline.bind(redis);
  let fired = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const writes = commands.some((c) => (c[0] === "HSET" && c[1] === notes) || (c[0] === "EVAL" && c.includes(notes)));
    if (writes && !fired) {
      fired = true;
      redis.pipeline = pipeline;
      await between();
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  return () => fired;
}

async function main(): Promise<void> {
  redis.clear();
  const w = await makeWorld();
  const statsId = w.store.statsId as string;
  const listId = w.store.listId as string;
  await seedPerson(w, "tess-4385@example.com", null);
  const tess = personKey(statsId, "tess-4385@example.com");
  const sam = personKey(statsId, "sam-4385@example.com");
  const used = async () => (await dataUsed(w.store))?.used ?? -1;
  const listed = async (person: string) => (await redisPipeline([["SISMEMBER", `nl:person:${statsId}:who`, person]]))[0];

  part("A note taken before an erasure, written after it, brings nothing back (issue #4385)");
  const before = await used();
  const ran = beforeTheWrite(statsId, tess, () => erasePerson(w.store, "tess-4385@example.com", { kind: "person" }));
  const late = await addPersonNote(statsId, tess, "keeper@example.com", "Asked about the course dates.", w.store, Date.now(), { listId, email: "tess-4385@example.com" });
  is("the erasure ran between the note's room and its write", ran(), true);
  is("the late note is refused", late, null);
  is("no note about them is there", (await readPersonNotes(statsId, tess)).length, 0);
  is("they are not listed among the noted people", await listed(tess), 0);
  is("the room the note took comes back, as the erasure left it", (await used()) <= before, true);

  part("After the erasure, a sequence's note step writes nothing");
  const room = await used();
  is("refused", await addPersonNote(statsId, tess, "sequence", "Step 2.", w.store, Date.now(), { listId, email: "tess-4385@example.com" }), null);
  is("the room it took is given back whole", await used(), room);
  is("nothing about them is there", [(await readPersonNotes(statsId, tess)).length, await listed(tess)], [0, 0]);

  part("A buyer who was not deleted is noted as before");
  const kept = await addPersonNote(statsId, sam, "keeper@example.com", "Prefers email.", w.store, Date.now(), { listId, email: "sam-4385@example.com" });
  is("their note is there", kept?.length, 1);

  part("A store with no list cannot tell who was deleted: nothing is written");
  is("refused", await addPersonNote(statsId, sam, "keeper@example.com", "Another.", w.store, Date.now(), { listId: null, email: "sam-4385@example.com" }), null);
  is("their notes are as they were", (await readPersonNotes(statsId, sam)).length, 1);

  part("Their own yes again lifts the mark with the suppression print, and they may be noted again");
  await upsertContact(listId, "tess-4385@example.com", { agreed: true, explicit: true, source: "free", at: new Date().toISOString() }, w.store);
  is("noted again", (await addPersonNote(statsId, tess, "sequence", "Step 2.", w.store, Date.now(), { listId, email: "tess-4385@example.com" }))?.length, 1);

  done();
}

void main();
