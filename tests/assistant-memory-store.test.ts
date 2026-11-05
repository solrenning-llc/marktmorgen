/**
 * 639 [GL7](40), unit 2: where the creator's assistant keeps the creator's
 * own notes (lib/assistant-memory-store.ts). Kept per store, room taken
 * before writing, the rules' refusals kept, whatever is read back checked
 * again, and everything forgotten at once. Changes made at the same instant
 * are each kept or refused as busy, never quietly undone; a record that
 * cannot be read is never written over; the lock is let go of after a write
 * that failed.
 */
import { MAX_MEMORY_NOTES, NOTE_ID, type MemoryNote } from "@/lib/assistant-memory-rules";
import { MEMORY_STORE_REFUSALS, MemoryWriteUnconfirmed, changeNote, dropNote, forgetMemory, keepNote, newNoteId, readMemory, readMemoryState } from "@/lib/assistant-memory-store";
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
  const left = (change: Awaited<ReturnType<typeof dropNote>>) => (change.ok ? change.notes.length : change.error);
  is("one removed", left(await dropNote(STATS, id, ROOM)), 1);
  is("removing one that is gone is fine", left(await dropNote(STATS, id, ROOM)), 1);

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
  is("a record that cannot be read is none to the assistant", await readMemory(STATS), []);
  is("and said so to the studio", await readMemoryState(STATS), { ok: false, error: "unreadable" });
  is("no record at all is no notes", await readMemoryState("n".repeat(16)), { ok: true, notes: [] });

  part("A record that cannot be read is never written over");
  const corrupt = async (raw: string, name: string) => {
    await redis.pipeline([["SET", KEY, raw]]);
    const used = (await dataUsed(ROOM))?.used ?? 0;
    is(`${name}: a new note refused`, await keepNote(STATS, { kind: "preference", text: "Be brief." }, ROOM, NOW), { ok: false, error: "unreadable" });
    is(`${name}: a change refused`, await changeNote(STATS, "abcdefghij", { text: "Be brief." }, ROOM, NOW), { ok: false, error: "unreadable" });
    is(`${name}: a removal refused`, await dropNote(STATS, "abcdefghij", ROOM), { ok: false, error: "unreadable" });
    const [kept] = await redis.pipeline([["GET", KEY]]);
    is(`${name}: the record as it was`, kept, raw);
    is(`${name}: its room as it was`, (await dataUsed(ROOM))?.used ?? 0, used);
    is(`${name}: and the lock let go of`, has(`nl:amem:lock:${STATS}`), false);
  };
  await corrupt("{not json", "not JSON");
  await corrupt(JSON.stringify({ id: "abcdefghij", text: "Fine note" }), "not a list");
  is("the refusal in plain words", MEMORY_STORE_REFUSALS.unreadable, "Your assistant's notes could not be read just now, so nothing was changed. Try again in a moment.");
  await forgetMemory(STATS, ROOM);
  is("forgetting still takes it away", has(KEY), false);

  part("Changes at the same instant: each kept, or refused as busy");
  const SAME = "s".repeat(16);
  const texts = ["Write in a warm voice.", "Never promise a date.", "Sign off with thanks.", "Keep answers short."];
  const kept = await Promise.all(texts.map((text) => keepNote(SAME, { kind: "preference", text }, ROOM, NOW)));
  const keptOk = texts.filter((_, at) => kept[at].ok);
  is("every one answered as kept or busy", kept.every((result) => result.ok || result.error === "busy"), true);
  is("every one said kept is kept", (await readMemory(SAME)).map((note) => note.text).sort(), [...keptOk].sort());
  is("here, all of them", keptOk.length, texts.length);
  const ids = (await readMemory(SAME)).map((note) => note.id);
  const changed = await Promise.all([changeNote(SAME, ids[0], { text: "Write in a cool voice." }, ROOM, NOW), changeNote(SAME, ids[1], { text: "Never promise a time." }, ROOM, NOW)]);
  is("two changes at once: both kept", [changed.map((result) => result.ok), (await readMemory(SAME)).slice(0, 2).map((note) => note.text)], [[true, true], ["Write in a cool voice.", "Never promise a time."]]);
  const dropped = await Promise.all([dropNote(SAME, ids[0], ROOM), dropNote(SAME, ids[2], ROOM)]);
  is("two removals at once: both gone", [dropped.map((result) => result.ok), (await readMemory(SAME)).map((note) => note.id)], [[true, true], [ids[1], ids[3]]]);

  part("Busy: a change held too long is refused, and nothing written");
  const before2 = JSON.stringify(await readMemory(SAME));
  await redis.pipeline([["SET", `nl:amem:lock:${SAME}`, "someone-else", "NX", "EX", 10]]);
  const started = Date.now();
  is("refused as busy", await keepNote(SAME, { kind: "preference", text: "One while busy." }, ROOM, NOW), { ok: false, error: "busy" });
  is("after waiting a little, not long", [Date.now() - started >= 1_000, Date.now() - started < 4_000], [true, true]);
  is("a removal refused as busy too", await dropNote(SAME, ids[1], ROOM), { ok: false, error: "busy" });
  is("the notes as they were", JSON.stringify(await readMemory(SAME)), before2);
  const [other] = await redis.pipeline([["GET", `nl:amem:lock:${SAME}`]]);
  is("somebody else's lock is never let go of by us", other, "someone-else");
  is("the refusal in plain words", MEMORY_STORE_REFUSALS.busy, "Someone else is changing these notes right now. Try again in a moment.");
  await redis.pipeline([["DEL", `nl:amem:lock:${SAME}`]]);

  part("A write whose answer is lost lets go of the lock, says so, and keeps the larger room (Codex G2 on #1949)");
  const pipeline = redis.pipeline;
  const usedBefore = (await dataUsed(ROOM))?.used ?? 0;
  redis.pipeline = async (commands) => {
    if (commands.some((command) => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:amem-write:v1") && command[4] === `nl:amem:${SAME}`)) throw new Error("synthetic write failure");
    return pipeline(commands);
  };
  let failed: unknown = null;
  try {
    await keepNote(SAME, { kind: "preference", text: "One that fails." }, ROOM, NOW);
  } catch (error) {
    failed = error;
  } finally {
    redis.pipeline = pipeline;
  }
  is("it is said unconfirmed, never saved", failed instanceof MemoryWriteUnconfirmed, true);
  is("the lock is let go of", has(`nl:amem:lock:${SAME}`), false);
  is("the notes as they were", JSON.stringify(await readMemory(SAME)), before2);
  is("their room kept at the larger record's, never given back on an answer that is not Redis's", ((await dataUsed(ROOM))?.used ?? 0) > usedBefore, true);
  const after = await keepNote(SAME, { kind: "preference", text: "One after the failure." }, ROOM, NOW);
  is("the next change goes through", [after.ok, (await readMemory(SAME)).map((note: MemoryNote) => note.text).at(-1)], [true, "One after the failure."]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
