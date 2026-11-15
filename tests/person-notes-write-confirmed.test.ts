/**
 * Codex X5's CHANGES on #3159 at 6774597682: saving and pruning a buyer's notes did not confirm the writes.
 *
 * - addPersonNote took the note's room, sent HSET and never read its reply: a write Redis did not confirm was
 *   answered with the notes as if the new one were kept.
 * - Past MAX_PERSON_NOTES it sent HDEL for the oldest and gave their room back without reading its reply: when the
 *   delete did not happen, the notes stayed and their room was given back all the same, so the store's data room
 *   counted less than it held and could grow past its ceiling.
 *
 * Now a write whose reply is not exactly its own is unknown (UnknownReplyError, its room kept, never given back on
 * a guess), and a pruned note gives its room back only when its own HDEL answered 1. Synthetic data only.
 */
import { addPersonNote, MAX_PERSON_NOTES, readPersonNotes } from "@/lib/buyer-profile";
import { dataUsed } from "@/lib/store-data";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const STATS = "s".repeat(32);
const person = personKey(STATS, "buyer@example.com");
const used = async () => (await dataUsed(ROOM))?.used ?? -1;

/** The next pipeline holding this command answers `reply` instead, without running. */
function answerOnce(command: string, reply: unknown[]): () => void {
  const real = redis.pipeline.bind(redis);
  let once = true;
  redis.pipeline = async (commands) => {
    if (once && commands.some((c) => c[0] === command)) {
      once = false;
      return reply as never;
    }
    return real(commands);
  };
  return () => {
    redis.pipeline = real;
  };
}

async function main(): Promise<void> {
  part("A save whose write Redis did not confirm is not answered as saved");
  redis.clear();
  let restore = answerOnce("HSET", ["?", 1, 1, 1]);
  const saved = await addPersonNote(STATS, person, "team@example.com", "Asked about a refund", ROOM).then(
    () => "answered as saved",
    (error: unknown) => (error instanceof Error ? error.name : String(error)),
  );
  restore();
  is("an unconfirmed write is unknown, never the notes as if it were kept", saved, "UnknownReplyError");

  part("Pruning past the ceiling gives room back only for notes really deleted");
  // What one save takes when nothing is pruned: the yardstick.
  redis.clear();
  await addPersonNote(STATS, person, "team@example.com", "Note A", ROOM);
  const one = await used();
  await addPersonNote(STATS, person, "team@example.com", "Note B", ROOM);
  const save = (await used()) - one;
  redis.clear();
  for (let i = 0; i < MAX_PERSON_NOTES; i += 1) await addPersonNote(STATS, person, "team@example.com", `Note ${i}`, ROOM, Date.now() - (MAX_PERSON_NOTES - i) * 1000);
  const before = await used();
  restore = answerOnce("HDEL", ["?"]);
  await addPersonNote(STATS, person, "team@example.com", "Note X", ROOM).catch(() => null);
  restore();
  const kept = (await readPersonNotes(STATS, person)).length;
  is("the delete did not happen: every note is still there", kept, MAX_PERSON_NOTES + 1);
  is("and the room grew by one whole save: nothing given back on a delete that did not happen", (await used()) - before, save);

  part("Control: a save and a prune that work are unchanged");
  redis.clear();
  for (let i = 0; i < MAX_PERSON_NOTES + 1; i += 1) await addPersonNote(STATS, person, "team@example.com", `Note ${i}`, ROOM, Date.now() - (MAX_PERSON_NOTES + 1 - i) * 1000);
  is("the oldest went", (await readPersonNotes(STATS, person)).length, MAX_PERSON_NOTES);
  done();
}

void main();
