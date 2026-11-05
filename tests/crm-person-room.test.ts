/**
 * Deleting a person from the CRM (forgetCrmPerson, lib/person-erasure.ts)
 * gives back to the store's data room what their values and deals took, once,
 * so a store that deletes buyers is never left paying for records it no
 * longer keeps.
 */
import { CRM_VALUE_MOST_BYTES, CrmPersonGone, ERASED_MARK_SECONDS, forgetCrmPerson, personReturned, readFields, readGeneration, readValues, setValue, writeDeal, writeFields } from "@/lib/crm";
import { personKey } from "@/lib/person-key";
import { SESSION_TTL_SECONDS } from "@/lib/auth";
import { LEASE_SECONDS } from "@/lib/flows";
import { utf8Length } from "@/lib/store-data-rules";
import { DEFAULT_STAGES, type Deal, MAX_DEALS } from "@/lib/crm-rules";
import { dataUsed } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { advance, store as redis } from "./redis-stub";
import { ROOM, roomOnly } from "./data-room";
import { done, is, part } from "./check";

const STATS = "p".repeat(16);
const ANA = "a".repeat(32);
const BEN = "b".repeat(32);
const CAL = personKey(STATS, "cal@example.com");
const DAN = personKey(STATS, "dan@example.com");
const deal = (id: string, email: string): Deal => ({ id, title: "Proposal", email, cents: 10_000, stage: DEFAULT_STAGES[0].id, note: "", createdAt: 100, updatedAt: 100 });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;

  part("A deleted person's values and deals give their room back");
  await writeFields(STATS, [{ id: "fielda", name: "Company", type: "text", options: [] }, { id: "fieldb", name: "Goal", type: "text", options: [] }]);
  const fields = await readFields(STATS);
  is("two fields kept", fields.length, 2);
  // Ben first, so the room's own slots already exist and Ana's records are all that changes.
  await setValue(STATS, BEN, fields[0], "Contoso", ROOM, 0);
  await writeDeal(STATS, deal("dealcccccc", "ben@example.com"), ROOM);
  const withBen = await used();
  await setValue(STATS, ANA, fields[0], "Northwind Traders", ROOM, 0);
  await setValue(STATS, ANA, fields[1], "A course for her whole team", ROOM, 0);
  await writeDeal(STATS, deal("dealaaaaaa", "ana@example.com"), ROOM);
  await writeDeal(STATS, deal("dealbbbbbb", "Ana@Example.com "), ROOM);
  const withAna = await used();
  is("Ana's records take room", withAna > withBen, true);

  const records = await forgetCrmPerson(STATS, ANA, "ana@example.com", ROOM);
  is("two values and two deals deleted", records, 4);
  is("exactly Ana's room is given back", await used(), withBen);
  is("Ben's values are kept", (await readValues(STATS, BEN, fields)).fielda, "Contoso");

  part("Given back once");
  const after = await used();
  is("a second deletion deletes nothing", await forgetCrmPerson(STATS, ANA, "ana@example.com", ROOM), 0);
  is("and gives nothing more back", await used(), after);

  part("A deal edited while its person is deleted is not written back");
  const kept = deal("dealdddddd", "ana@example.com");
  await writeDeal(STATS, kept, ROOM);
  const beforeEdit = await used();
  // The edit read the deal, then the deletion ran, then the edit saves.
  await forgetCrmPerson(STATS, ANA, "ana@example.com", ROOM);
  const afterDeletion = await used();
  is("the deletion gave its room back", beforeEdit > afterDeletion, true);
  is("the edit answers that the deal is gone", await writeDeal(STATS, { ...kept, title: "Edited" }, ROOM, "edit"), "gone");
  is("and the deal is not there again", (await redis.pipeline([["HEXISTS", `nl:crm:deals:${STATS}`, kept.id]]))[0], 0);
  is("nor its room taken", await used(), afterDeletion);
  is("an edit of a deal still there is written", [await writeDeal(STATS, deal("dealcccccc", "ben@example.com"), ROOM, "edit")], [true]);

  part("A value set while its person is deleted: never left behind, and the room is exactly what is kept");
  const original = redis.pipeline;
  const outcome = async (run: () => Promise<boolean>): Promise<unknown> => {
    try { return await run(); } catch (error) { return error instanceof CrmPersonGone ? "gone" : String(error); }
  };
  const marked = async (person: string) => (await redis.pipeline([["EXISTS", `nl:crm:erased:${STATS}:${person}`]]))[0];
  try {
    const empty = await used();
    await setValue(STATS, CAL, fields[0], "Northwind", ROOM, 0);
    is("Cal's first value takes its room", await used(), empty + dataBytes([CAL, "Northwind"], 1));
    await setValue(STATS, CAL, fields[0], "Northwind Traders", ROOM, 0);
    is("a value replaced counts only what is kept", await used(), empty + dataBytes([CAL, "Northwind Traders"], 1));
    // The reviewer's order: the page was read, the save has started (its room is being taken), the deletion runs to its
    // end, then the save writes.
    const read = await readGeneration(STATS, CAL);
    is("(never deleted: generation 0)", read, 0);
    let armed = true;
    redis.pipeline = async (commands) => {
      if (armed && roomOnly(commands)) {
        armed = false;
        await forgetCrmPerson(STATS, CAL, "cal@example.com", ROOM);
      }
      return original.call(redis, commands);
    };
    is("the save is refused: the person is gone", await outcome(() => setValue(STATS, CAL, fields[0], "Northwind Traders International, ".repeat(12), ROOM, read)), "gone");
    is("the deletion ran in between", armed, false);
    redis.pipeline = original;
    is("the value is not there after the deletion", (await readValues(STATS, CAL, fields)).fielda, undefined);
    is("and the room counted is exactly what is kept: nothing of Cal's", await used(), empty);

    part("While they are deleted, nothing a request says writes about them (C3-125, the reviewer's case)");
    const now = await readGeneration(STATS, CAL);
    is("their generation is one more", now, 1);
    // However long ago the deletion was, and whatever a save carries: a page read before, one read since, a made-up one.
    await redis.pipeline([["SET", `nl:crm:erased:${STATS}:${CAL}`, String(Date.now() - 86_400_000), "EX", ERASED_MARK_SECONDS]]);
    for (const carried of [0, now, now + 1, -1, Number.NaN, Date.now()]) {
      is(`refused, carrying ${carried}`, await outcome(() => setValue(STATS, CAL, fields[1], "Back again", ROOM, carried)), "gone");
    }
    is("a cleared value too", await outcome(() => setValue(STATS, CAL, fields[0], "", ROOM, now)), "gone");
    is("nothing of Cal's is kept", await readValues(STATS, CAL, fields), {});
    is("the room taken first is given back", await used(), empty);
    is("and the mark stays", await marked(CAL), 1);
    // The mark lasts as long as a save prepared before can still arrive: a studio page's session, a workflow step's lease.
    is("the mark outlasts a studio session and a workflow step's lease", [ERASED_MARK_SECONDS >= SESSION_TTL_SECONDS, ERASED_MARK_SECONDS >= LEASE_SECONDS], [true, true]);
    const ttls = await redis.pipeline([["TTL", `nl:crm:erased:${STATS}:${CAL}`], ["TTL", `nl:crm:gen:${STATS}:${CAL}`]]);
    is("the mark and the generation are kept that long", ttls, [ERASED_MARK_SECONDS, ERASED_MARK_SECONDS]);

    part("Someone who came back on their own (a paid order, a confirmed sign-up, a free product, a form): the server takes the mark away");
    await personReturned(STATS, "cal@example.com", Date.now() - 2 * 86_400_000);
    is("an act from before the deletion, seen only now, leaves the mark (Codex D, #2287)", await marked(CAL), 1);
    await personReturned(STATS, "cal@example.com", Number.NaN);
    is("and so does an unknown time", await marked(CAL), 1);
    await personReturned(STATS, "cal@example.com", Date.now() + 1);
    is("the mark is gone", await marked(CAL), 0);
    is("a page read before the deletion is still refused", await outcome(() => setValue(STATS, CAL, fields[0], "Stale", ROOM, read)), "gone");
    const since = await readGeneration(STATS, CAL);
    is("a page read since writes", await outcome(() => setValue(STATS, CAL, fields[0], "Returned customer", ROOM, since)), true);
    is("and is kept", (await readValues(STATS, CAL, fields)).fielda, "Returned customer");
    is("its room counted", await used(), empty + dataBytes([CAL, "Returned customer"], 1));
    is("Cal deleted again", await forgetCrmPerson(STATS, CAL, "cal@example.com", ROOM), 1);
    is("with his room, and a generation more", [await used(), await readGeneration(STATS, CAL)], [empty, 2]);

    part("What a value set sends (the whole save is measured through the route in tests/crm-contact-writes.test.ts)");
    let commands = 0;
    redis.pipeline = async (sent) => {
      commands += sent.length;
      return original.call(redis, sent);
    };
    await setValue(STATS, DAN, fields[0], "\u20ac".repeat(200), ROOM, 0);
    const first = commands;
    await setValue(STATS, DAN, fields[0], "\u00e9".repeat(200), ROOM, 0);
    redis.pipeline = original;
    is("a new value: the room taken and the write", first, 2);
    is("one replaced: and its room given back", commands - first, 3);
    is("(the widest a value takes is counted)", CRM_VALUE_MOST_BYTES >= utf8Length("\u20ac".repeat(200)), true);
    is("Dan deleted", await forgetCrmPerson(STATS, DAN, "dan@example.com", ROOM), 1);
    is("with his room", await used(), empty);
  } finally {
    redis.pipeline = original;
  }

  part("An edit of a deleted deal on a full board is gone, not full, and touches no room");
  const others = Array.from({ length: MAX_DEALS - 1 }, (_, i) => `full${String(i).padStart(6, "0")}`);
  await redis.pipeline([["HSET", `nl:crm:deals:${STATS}`, ...others.flatMap((id) => [id, JSON.stringify(deal(id, "x@example.com"))])]]);
  is("the board is full", (await redis.pipeline([["HLEN", `nl:crm:deals:${STATS}`]]))[0], MAX_DEALS);
  let roomCalls = 0;
  redis.pipeline = async (commands) => {
    if (roomOnly(commands)) roomCalls += 1;
    return original.call(redis, commands);
  };
  try {
    is("the edit answers gone", await writeDeal(STATS, { ...kept, title: "Edited again" }, ROOM, "edit"), "gone");
  } finally {
    redis.pipeline = original;
  }
  is("the store's data room was not touched", roomCalls, 0);
  is("and the deal is not there again", (await redis.pipeline([["HEXISTS", `nl:crm:deals:${STATS}`, kept.id]]))[0], 0);
  await redis.pipeline([["HDEL", `nl:crm:deals:${STATS}`, ...others]]);

  part("Once the mark and the generation have gone by themselves, a save is written, as for anyone");
  advance(ERASED_MARK_SECONDS * 1000 + 1_000);
  is("the mark and the generation are gone", (await redis.pipeline([["EXISTS", `nl:crm:erased:${STATS}:${CAL}`, `nl:crm:gen:${STATS}:${CAL}`]]))[0], 0);
  is("a value is set", await setValue(STATS, CAL, fields[0], "Returned customer", ROOM, await readGeneration(STATS, CAL)), true);
  is("and kept", (await readValues(STATS, CAL, fields)).fielda, "Returned customer");

  part("Without a room nothing is counted, and nothing breaks");
  is("Ben deleted", await forgetCrmPerson(STATS, BEN, "ben@example.com"), 2);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
