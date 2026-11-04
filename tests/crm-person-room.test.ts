/**
 * Deleting a person from the CRM (forgetCrmPerson, lib/person-erasure.ts)
 * gives back to the store's data room what their values and deals took, once,
 * so a store that deletes buyers is never left paying for records it no
 * longer keeps.
 */
import { SET_CRM_VALUE, forgetCrmPerson, readFields, readValues, setValue, writeDeal, writeFields } from "@/lib/crm";
import { DEFAULT_STAGES, type Deal, MAX_DEALS } from "@/lib/crm-rules";
import { LockBusyError } from "@/lib/redis-lock";
import { dataUsed } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { ROOM, roomOnly } from "./data-room";
import { done, is, part } from "./check";

const STATS = "p".repeat(16);
const ANA = "a".repeat(32);
const BEN = "b".repeat(32);
const CAL = "c".repeat(32);
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
  await setValue(STATS, BEN, fields[0], "Contoso", ROOM);
  await writeDeal(STATS, deal("dealcccccc", "ben@example.com"), ROOM);
  const withBen = await used();
  await setValue(STATS, ANA, fields[0], "Northwind Traders", ROOM);
  await setValue(STATS, ANA, fields[1], "A course for her whole team", ROOM);
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
  try {
    const empty = await used();
    await setValue(STATS, CAL, fields[0], "Northwind", ROOM);
    is("Cal's first value takes its room", await used(), empty + dataBytes([CAL, "Northwind"], 1));
    await setValue(STATS, CAL, fields[0], "Northwind Traders", ROOM);
    is("a value replaced counts only what is kept", await used(), empty + dataBytes([CAL, "Northwind Traders"], 1));
    // The reviewer's order: the change has started (its room is being taken), the deletion runs, then the change writes.
    let armed = true;
    let erasure: Promise<number> | null = null;
    redis.pipeline = async (commands) => {
      if (armed && roomOnly(commands)) {
        armed = false;
        erasure = forgetCrmPerson(STATS, CAL, "cal@example.com", ROOM);
        // The deletion runs to its end here, unless it has to wait for the change.
        await Promise.race([erasure, new Promise((resolve) => setTimeout(resolve, 300))]);
      }
      return original.call(redis, commands);
    };
    is("the change answers it was set", await setValue(STATS, CAL, fields[0], "Northwind Traders International, ".repeat(12), ROOM), true);
    is("the deletion ran in between", armed, false);
    await erasure;
    redis.pipeline = original;
    is("the value is not there after the deletion", (await readValues(STATS, CAL, fields)).fielda, undefined);
    is("and the room counted is exactly what is kept: nothing of Cal's", await used(), empty);

    part("A change whose lock ran out before its write writes nothing, and gives its room back");
    await setValue(STATS, CAL, fields[0], "Contoso", ROOM);
    const withCal = await used();
    redis.pipeline = async (commands) => {
      if (commands.some((c) => c[0] === "EVAL" && c[1] === SET_CRM_VALUE)) await original.call(redis, [["DEL", `nl:crm:tasklock:${STATS}`]]);
      return original.call(redis, commands);
    };
    let busy = false;
    try { await setValue(STATS, CAL, fields[0], "Contoso Pharmaceuticals, ".repeat(12), ROOM); } catch (error) { busy = error instanceof LockBusyError; }
    redis.pipeline = original;
    is("LockBusyError", busy, true);
    is("the value is as it was", (await readValues(STATS, CAL, fields)).fielda, "Contoso");
    is("and so is the room", await used(), withCal);
    is("Cal deleted", await forgetCrmPerson(STATS, CAL, "cal@example.com", ROOM), 1);
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

  part("Without a room nothing is counted, and nothing breaks");
  is("Ben deleted", await forgetCrmPerson(STATS, BEN, "ben@example.com"), 2);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
