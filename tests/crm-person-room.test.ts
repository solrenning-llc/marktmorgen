/**
 * Deleting a person from the CRM (forgetCrmPerson, lib/person-erasure.ts)
 * gives back to the store's data room what their values and deals took, once,
 * so a store that deletes buyers is never left paying for records it no
 * longer keeps.
 */
import { CRM_VALUE_SET_BYTES, CRM_VALUE_SET_SENT, CrmPersonGone, ERASED_CLOCK_MS, ERASED_MARK_SECONDS, forgetCrmPerson, readFields, readValues, setValue, writeDeal, writeFields } from "@/lib/crm";
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
const CAL = "c".repeat(32);
const DAN = "d".repeat(32);
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
  await setValue(STATS, BEN, fields[0], "Contoso", ROOM, Date.now());
  await writeDeal(STATS, deal("dealcccccc", "ben@example.com"), ROOM);
  const withBen = await used();
  await setValue(STATS, ANA, fields[0], "Northwind Traders", ROOM, Date.now());
  await setValue(STATS, ANA, fields[1], "A course for her whole team", ROOM, Date.now());
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
  // A mark's time put back, as if the deletion were a minute old (the clock of a test does not move by itself).
  const markAgo = async (person: string, ms: number) => {
    const key = `nl:crm:erased:${STATS}:${person}`;
    const [at] = await redis.pipeline([["GET", key]]);
    await redis.pipeline([["SET", key, String(Number(at) - ms), "EX", ERASED_MARK_SECONDS]]);
  };
  try {
    const empty = await used();
    await setValue(STATS, CAL, fields[0], "Northwind", ROOM, Date.now());
    is("Cal's first value takes its room", await used(), empty + dataBytes([CAL, "Northwind"], 1));
    await setValue(STATS, CAL, fields[0], "Northwind Traders", ROOM, Date.now());
    is("a value replaced counts only what is kept", await used(), empty + dataBytes([CAL, "Northwind Traders"], 1));
    // The reviewer's order: the page was drawn, the save has started (its room is being taken), the deletion runs to its
    // end, then the save writes.
    const drawn = Date.now();
    let armed = true;
    redis.pipeline = async (commands) => {
      if (armed && roomOnly(commands)) {
        armed = false;
        await forgetCrmPerson(STATS, CAL, "cal@example.com", ROOM);
      }
      return original.call(redis, commands);
    };
    is("the save, prepared before the deletion, is refused: the person is gone", await outcome(() => setValue(STATS, CAL, fields[0], "Northwind Traders International, ".repeat(12), ROOM, drawn)), "gone");
    is("the deletion ran in between", armed, false);
    redis.pipeline = original;
    is("the value is not there after the deletion", (await readValues(STATS, CAL, fields)).fielda, undefined);
    is("and the room counted is exactly what is kept: nothing of Cal's", await used(), empty);

    part("A save prepared before the deletion, arriving after it finished, never puts anything back");
    is("refused: the person is gone", await outcome(() => setValue(STATS, CAL, fields[1], "Back again", ROOM, drawn)), "gone");
    is("a cleared value too", await outcome(() => setValue(STATS, CAL, fields[0], "", ROOM, drawn)), "gone");
    is("one with no time is taken as prepared before", await outcome(() => setValue(STATS, CAL, fields[1], "Back again", ROOM, Number.NaN)), "gone");
    is("so is one prepared within the clocks' difference of it", await outcome(() => setValue(STATS, CAL, fields[1], "Back again", ROOM, Date.now())), "gone");
    is("nothing of Cal's is kept", await readValues(STATS, CAL, fields), {});
    is("and the room taken first is given back", await used(), empty);
    // The mark lasts as long as a save prepared before can still arrive: a studio page's session, a workflow step's lease.
    is("the mark outlasts a studio session and a workflow step's lease", [ERASED_MARK_SECONDS >= SESSION_TTL_SECONDS, ERASED_MARK_SECONDS >= LEASE_SECONDS], [true, true]);
    const [mark] = await redis.pipeline([["GET", `nl:crm:erased:${STATS}:${CAL}`]]);
    is("it holds only when they were deleted, and is kept that long", [/^\d{13}$/.test(String(mark)), (await redis.pipeline([["TTL", `nl:crm:erased:${STATS}:${CAL}`]]))[0]], [true, ERASED_MARK_SECONDS]);

    part("Someone who came back: a save prepared after the deletion is written, and the mark goes");
    await markAgo(CAL, ERASED_CLOCK_MS + 60_000);
    const stale = Number((await redis.pipeline([["GET", `nl:crm:erased:${STATS}:${CAL}`]]))[0]) - 1;
    is("a page drawn before is still refused", await outcome(() => setValue(STATS, CAL, fields[0], "Stale", ROOM, stale)), "gone");
    is("a page drawn after writes", await outcome(() => setValue(STATS, CAL, fields[0], "Returned customer", ROOM, Date.now())), true);
    is("and is kept", (await readValues(STATS, CAL, fields)).fielda, "Returned customer");
    is("the mark is gone", (await redis.pipeline([["EXISTS", `nl:crm:erased:${STATS}:${CAL}`]]))[0], 0);
    is("its room counted", await used(), empty + dataBytes([CAL, "Returned customer"], 1));
    is("Cal deleted again", await forgetCrmPerson(STATS, CAL, "cal@example.com", ROOM), 1);
    is("with his room", await used(), empty);

    part("What a value set sends, held under its cost line (tests/plan-cost-registry.ts, CRM_VALUE_SET)");
    let commands = 0;
    let bytes = 0;
    const size = (value: unknown): number => (typeof value === "string" ? utf8Length(value) : typeof value === "number" ? String(value).length : Array.isArray(value) ? value.reduce((n: number, v) => n + size(v), 0) : 0);
    redis.pipeline = async (sent) => {
      commands += sent.length;
      const replies = await original.call(redis, sent);
      bytes += size(sent.map((c) => c.filter((part) => !String(part).startsWith("-- marktmorgen:")))) + size(replies);
      return replies;
    };
    await setValue(STATS, DAN, fields[0], "\u20ac".repeat(200), ROOM, Date.now());
    const first = commands;
    await setValue(STATS, DAN, fields[0], "\u00e9".repeat(200), ROOM, Date.now());
    redis.pipeline = original;
    is("a new value: the room taken and the write", first, 2);
    is("one replaced: and its room given back, CRM_VALUE_SET_SENT in all", commands - first, CRM_VALUE_SET_SENT);
    is(`within its bytes (${bytes} for both)`, bytes <= 2 * CRM_VALUE_SET_BYTES, true);
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

  part("Once the mark has gone by itself, any save is written, as for anyone");
  await forgetCrmPerson(STATS, CAL, "cal@example.com", ROOM);
  const before = Date.now() - 60_000;
  advance(ERASED_MARK_SECONDS * 1000 + 1_000);
  is("the mark is gone", (await redis.pipeline([["EXISTS", `nl:crm:erased:${STATS}:${CAL}`]]))[0], 0);
  is("a value is set", await setValue(STATS, CAL, fields[0], "Returned customer", ROOM, before), true);
  is("and kept", (await readValues(STATS, CAL, fields)).fielda, "Returned customer");

  part("Without a room nothing is counted, and nothing breaks");
  is("Ben deleted", await forgetCrmPerson(STATS, BEN, "ben@example.com"), 2);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
