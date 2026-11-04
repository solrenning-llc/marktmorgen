/**
 * Deleting a person from the CRM (forgetCrmPerson, lib/person-erasure.ts)
 * gives back to the store's data room what their values and deals took, once,
 * so a store that deletes buyers is never left paying for records it no
 * longer keeps.
 */
import { forgetCrmPerson, readFields, readValues, setValue, writeDeal, writeFields } from "@/lib/crm";
import { DEFAULT_STAGES, MAX_DEALS, type Deal } from "@/lib/crm-rules";
import { dataBytes } from "@/lib/store-data-rules";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const STATS = "p".repeat(16);
const ANA = "a".repeat(32);
const BEN = "b".repeat(32);
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

  part("A value changed while its person is deleted keeps the room exact");
  const original = redis.pipeline;
  await setValue(STATS, ANA, fields[0], "First words", ROOM);
  const withFirst = await used();
  let raced = false;
  redis.pipeline = async (commands) => {
    // The change read the old value; the person's deletion runs before the change writes.
    if (!raced && commands[0]?.[0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:crm-value-swap:")) {
      raced = true;
      redis.pipeline = original;
      await forgetCrmPerson(STATS, ANA, "ana@example.com", ROOM);
    }
    return original.call(redis, commands);
  };
  const second = "A much longer second answer about the company";
  try {
    await setValue(STATS, ANA, fields[0], second, ROOM);
  } finally {
    redis.pipeline = original;
  }
  is("the deletion ran in between", raced, true);
  is("the value written is counted whole, never with the deleted one's room", (await used()) - (withFirst - dataBytes([ANA, "First words"], 1)), dataBytes([ANA, second], 1));
  await forgetCrmPerson(STATS, ANA, "ana@example.com", ROOM);
  is("and its deletion gives back exactly that", await used(), withFirst - dataBytes([ANA, "First words"], 1));

  part("An edit of a deleted deal is gone even when the board is full");
  redis.pipeline = async (commands) => (commands[0]?.[0] === "HEXISTS" ? [0, MAX_DEALS] : original.call(redis, commands));
  try {
    is("gone, not full", await writeDeal(STATS, deal("deleeeeeee", "ana@example.com"), ROOM, "edit"), "gone");
  } finally {
    redis.pipeline = original;
  }

  part("Without a room nothing is counted, and nothing breaks");
  is("Ben deleted", await forgetCrmPerson(STATS, BEN, "ben@example.com"), 2);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
