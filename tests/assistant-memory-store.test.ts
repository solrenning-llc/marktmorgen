/**
 * 639 [GL7](40), unit 2: where the creator's assistant keeps the creator's
 * own notes (lib/assistant-memory-store.ts). Kept per store, room taken
 * before writing, the rules' refusals kept, whatever is read back checked
 * again, and everything forgotten at once.
 */
import { MAX_MEMORY_NOTES, NOTE_ID } from "@/lib/assistant-memory-rules";
import { changeNote, dropNote, forgetMemory, keepNote, newNoteId, readMemory } from "@/lib/assistant-memory-store";
import { DataRoomError, dataUsed, needData, type DataStore } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const STATS = "m".repeat(16);
const KEY = `nl:amem:${STATS}`;
const NOW = 1_793_700_000;
const has = (name: string) => redis.keys().includes(name);

async function main(): Promise<void> {
  redis.clear();

  part("Kept for the store");
  is("a store with no notes", await readMemory(STATS), []);
  is("no store: nothing", await readMemory(null), []);
  const first = await keepNote(STATS, { kind: "preference", text: "Write in a warm, plain voice." }, ROOM, NOW);
  is("kept", first.ok, true);
  const notes = await readMemory(STATS);
  is("read back, with an id the store made", [notes.length, notes[0]?.text, NOTE_ID.test(notes[0]?.id ?? "")], [1, "Write in a warm, plain voice.", true]);
  is("ids are the rules' shape", NOTE_ID.test(newNoteId()), true);
  await keepNote(STATS, { kind: "instruction", text: "Never offer a discount above 20%." }, ROOM, NOW);
  is("a second one, last", (await readMemory(STATS)).map((note) => note.kind), ["preference", "instruction"]);
  is("another store's notes are its own", await readMemory("o".repeat(16)), []);

  part("The rules' refusals, and nothing written");
  const before = JSON.stringify(await readMemory(STATS));
  is("anyone's details refused", await keepNote(STATS, { kind: "preference", text: "Answer jane@example.com first" }, ROOM, NOW), { ok: false, error: "personal" });
  is("a kind is required", await keepNote(STATS, { kind: "rule", text: "Be brief." }, ROOM, NOW), { ok: false, error: "kind" });
  is("the notes as they were", JSON.stringify(await readMemory(STATS)), before);

  part("Changed and removed");
  const id = (await readMemory(STATS))[0].id;
  is("changed in place", [(await changeNote(STATS, id, { text: "Write in a short, plain voice." }, ROOM, NOW + 60)).ok, (await readMemory(STATS))[0].text], [true, "Write in a short, plain voice."]);
  is("a change with a link refused", await changeNote(STATS, id, { text: "See www.example.com" }, ROOM, NOW), { ok: false, error: "personal" });
  is("a note that is gone", await changeNote(STATS, "zzzzzzzzzz", { text: "Anything" }, ROOM, NOW), { ok: false, error: "unknown" });
  is("one removed", (await dropNote(STATS, id, ROOM)).length, 1);
  is("removing one that is gone is fine", (await dropNote(STATS, id, ROOM)).length, 1);

  part(`At most ${MAX_MEMORY_NOTES}`);
  for (let n = (await readMemory(STATS)).length; n < MAX_MEMORY_NOTES; n += 1) await keepNote(STATS, { kind: "preference", text: `Preference number ${n}` }, ROOM, NOW);
  is("thirty kept", (await readMemory(STATS)).length, MAX_MEMORY_NOTES);
  is("the thirty-first refused", await keepNote(STATS, { kind: "preference", text: "One more" }, ROOM, NOW), { ok: false, error: "full" });

  part("Room in the store's data room, taken first");
  is("what is kept is counted", ((await dataUsed(ROOM))?.used ?? 0) > 0, true);
  const tiny: DataStore = { ...ROOM, sid: "memory-tiny", tier: undefined, subscriptionActive: false, subscriptionId: "", trialEnds: 0, planEndedAt: "" };
  await needData(tiny, [{ slot: "fill", bytes: 5_000_000 - 64, set: true }]);
  let thrown: unknown = null;
  try {
    await keepNote("t".repeat(16), { kind: "preference", text: "Write in a warm, plain voice." }, tiny, NOW);
  } catch (error) {
    thrown = error;
  }
  is("a save that does not fit is refused as a full store", thrown instanceof DataRoomError, true);
  is("and nothing is kept", has(`nl:amem:${"t".repeat(16)}`), false);

  part("Forgotten at once");
  const held = (await dataUsed(ROOM))?.used ?? 0;
  await forgetMemory(STATS, ROOM);
  is("every note gone", [await readMemory(STATS), has(KEY)], [[], false]);
  is("and their room given back", ((await dataUsed(ROOM))?.used ?? 0) < held, true);
  await keepNote(STATS, { kind: "preference", text: "Be brief." }, ROOM, NOW);
  await dropNote(STATS, (await readMemory(STATS))[0].id, ROOM);
  is("removing the last note takes the record with it", has(KEY), false);

  part("As kept: whatever is stored is checked again");
  await redis.pipeline([["SET", KEY, JSON.stringify([{ id: "abcdefghij", kind: "preference", text: "Fine note", at: NOW }, { id: "klmnopqrst", kind: "preference", text: "Mail bob@example.com", at: NOW }])]]);
  is("a stored note with someone's details is left out", (await readMemory(STATS)).map((note) => note.text), ["Fine note"]);
  await redis.pipeline([["SET", KEY, "{not json"]]);
  is("a record that cannot be read is none", await readMemory(STATS), []);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
