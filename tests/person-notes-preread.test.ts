/**
 * Claude 3 (nuvem L) on #3159 @adf87817bd, LEVE: a buyer's notes hash holding one note that does not read made every
 * later save write a new note, take its room, and only then throw on the read that follows. The screen said "could
 * not confirm"; a second press wrote the note again and took its room again, never shown.
 *
 * Now addPersonNote reads the notes first: when they do not read exactly it refuses before taking room or writing
 * anything (PersonNotesUnreadableError, which the route answers as `notes_unreadable`, a refusal before writing, so
 * the box can say it did not save). Synthetic data only.
 */
import { addPersonNote, PersonNotesUnreadableError } from "@/lib/buyer-profile";
import { personNoteFailureWords } from "@/components/person-notes";
import { dataUsed } from "@/lib/store-data";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const STATS = "s".repeat(32);
const person = personKey(STATS, "buyer@example.com");
const used = async () => (await dataUsed(ROOM))?.used ?? -1;

async function main(): Promise<void> {
  redis.clear();
  await addPersonNote(STATS, person, "team@example.com", "Kept note", ROOM);
  // The notes' hash as lib/buyer-profile.ts names it (notesKey).
  const hash = `nl:person:${STATS}:n:${person}`;
  is("the notes hash holds the kept note", (await redis.pipeline([["HLEN", hash]]))[0], 1);
  await redis.pipeline([["HSET", hash, "deadbeef", "{not json"]]);
  const fieldsBefore = (await redis.pipeline([["HLEN", hash]]))[0];
  const roomBefore = await used();

  part("A save over notes that do not read refuses before writing");
  const outcome = await addPersonNote(STATS, person, "team@example.com", "Second press", ROOM).then(
    () => "answered",
    (error: unknown) => (error instanceof PersonNotesUnreadableError ? "refused before writing" : error instanceof Error ? error.name : String(error)),
  );
  is("refused before writing", outcome, "refused before writing");
  is("no note written", (await redis.pipeline([["HLEN", hash]]))[0], fieldsBefore);
  is("no room taken", await used(), roomBefore);

  part("The notes box says it did not save, because nothing was written");
  is("notes_unreadable is a refusal before writing", /did not save/i.test(personNoteFailureWords({ ok: false, error: "notes_unreadable" })), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
