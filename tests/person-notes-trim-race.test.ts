/**
 * Two notes added at once on a person at the cap give back the room of what they trimmed once, not twice.
 *
 * addPersonNote wrote its note, read the notes, HDEL'd every one past MAX_PERSON_NOTES and gave back the room of
 * every one it asked to drop, whatever the HDEL answered. Two notes added at the same moment both read the same
 * notes past the cap and both dropped the same oldest ones: the second HDEL removed nothing, but its give-back still
 * came off the store's data room, so the room counted less than the notes kept and the store could keep more than
 * its plan's data allows (Claude 7, Redis race hunt). Now only the notes the HDEL really removed give back their room.
 */
import { MAX_PERSON_NOTES, addPersonNote, readPersonNotes } from "@/lib/buyer-profile";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { ROOM } from "./data-room";

const STATS = "b".repeat(32);
const PERSON = "c".repeat(32);
const NOW = Date.parse("2026-11-12T12:00:00Z");
const pipeline = redis.pipeline.bind(redis);

async function used(): Promise<number> {
  const read = await dataUsed(ROOM, NOW);
  if (!read) throw new Error("the data room did not read");
  return read.used;
}

async function fill(): Promise<void> {
  redis.clear();
  for (let i = 0; i < MAX_PERSON_NOTES; i += 1) await addPersonNote(STATS, PERSON, "owner@example.com", `note ${i}`, ROOM, NOW + i * 1000);
}

async function main(): Promise<void> {
  // One after the other: the room each leaves is the reference.
  await fill();
  await addPersonNote(STATS, PERSON, "owner@example.com", "late a", ROOM, NOW + 100_000);
  await addPersonNote(STATS, PERSON, "owner@example.com", "late b", ROOM, NOW + 101_000);
  const alone = await used();
  is("one after the other: the cap holds", (await readPersonNotes(STATS, PERSON)).length, MAX_PERSON_NOTES);

  // At once: both notes are written before either reads the notes back to trim them.
  await fill();
  let written = 0;
  let release: () => void = () => {};
  const bothWritten = new Promise<void>((resolve) => {
    release = resolve;
  });
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "HGETALL" && String(commands[0][1]).startsWith("nl:person:")) await bothWritten;
    const answer = await pipeline(commands);
    if (commands[0]?.[0] === "HSET" && String(commands[0][1]).startsWith("nl:person:")) {
      written += 1;
      if (written === 2) release();
    }
    return answer;
  }) as typeof redis.pipeline;
  await Promise.all([
    addPersonNote(STATS, PERSON, "owner@example.com", "late a", ROOM, NOW + 100_000),
    addPersonNote(STATS, PERSON, "owner@example.com", "late b", ROOM, NOW + 101_000),
  ]);
  redis.pipeline = pipeline;
  is("at once: the cap holds", (await readPersonNotes(STATS, PERSON)).length, MAX_PERSON_NOTES);
  is("at once: the room counts what is kept, as one after the other does", await used(), alone);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
