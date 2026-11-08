/**
 * forgetNoted (lib/erasure-index.ts) reads an address's notes and deletes them, with every record they name, in one
 * step (disclosed on #3296, comment 6728207094).
 *
 * As two pipelines, a read (SMEMBERS, ZRANGEBYSCORE) and then a DEL, a writer that notes its record with
 * noteForErasure between them was lost: the read missed the new key, the DEL took the notes with the new key's entry
 * in them, and the new record, holding the erased buyer's address, was left with no note, so no later erasure could
 * find it.
 *
 * Held here:
 *   - a writer's note landing during forgetNoted leaves its record findable: a second erasure deletes it;
 *   - the healthy erasure deletes every noted record (both kinds of note) and the notes, and answers the same count
 *     as before; what does not start with "nl:" is never deleted; nothing noted, or no stats id, answers 0;
 *   - a reply not in its exact shape throws UnknownReplyError, never "nothing to delete"; a script Redis refuses
 *     (an index of another type) deletes nothing.
 *
 * Synthetic only: the Redis stand-in (lib/redis-memory.ts), which runs the script step for step. Its plain SMEMBERS
 * and ZRANGEBYSCORE make an empty set or sorted set when the key is missing, and take a key of another type as an
 * empty one (tests/sg2-unknown-replies.test.ts, part 4, says the same of its DEL count); Redis does neither. The
 * script's model reads as Redis does, so the part "as Redis counts" holds only for the one-step script: on the
 * two-step code those counts came out one or two too high in the stand-in, never in Redis.
 */
import { createHash } from "node:crypto";
import { forgetNoted, noteForErasure } from "@/lib/erasure-index";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const restore = () => {
  redis.pipeline = real;
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const STATS = "st_forget_atomic";
const PERSON = "ada@example.com";
const indexKey = `nl:erase:ix:${STATS}:${sha(`nimbus-erase-ix:${STATS}:${PERSON}`).slice(0, 32)}`;
const notesKey = `${indexKey}:z`;
const exists = async (key: string) => Number((await real([["EXISTS", key]]))[0]) === 1;
/** A record written for the address, with its note, in one pipeline, as every writer sends it. */
const write = async (record: string) => {
  await real([["SET", record, "{}"], ...noteForErasure(STATS, PERSON, record)]);
};
const touchesIndex = (commands: Command[]) => commands.some((c) => c.slice(1).some((part) => part === indexKey));
const rejects = (work: () => Promise<unknown>) =>
  work().then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.name : "thrown"),
  );

async function main(): Promise<void> {
  redis.clear();

  part("a writer's note landing during the erasure: its record is never left without a note");
  await write("nl:test:fa:old-1");
  const late = "nl:test:fa:late-1";
  let landed = false;
  // The writer runs right after the erasure's first call to Redis answers: between its read and its delete when
  // those are two steps, after the whole erasure when it is one.
  redis.pipeline = async (commands: Command[]) => {
    const replies = await real(commands);
    if (!landed && touchesIndex(commands)) {
      landed = true;
      await write(late);
    }
    return replies;
  };
  await forgetNoted(STATS, PERSON);
  restore();
  is("the writer did land during the erasure", landed, true);
  is("the record that was there before is deleted", await exists("nl:test:fa:old-1"), false);
  is("the late record is still noted, or already gone", !(await exists(late)) || (await exists(notesKey)), true);
  await forgetNoted(STATS, PERSON);
  is("a second erasure finds the late record and deletes it", await exists(late), false);

  part("the healthy erasure: every noted record and the notes, and the same count");
  redis.clear();
  await write("nl:test:fa:a");
  await write("nl:test:fa:b");
  await real([["SET", "nl:test:fa:old-kind", "{}"], ["SADD", indexKey, "nl:test:fa:old-kind", "nl:test:fa:a", "other:not-ours"]]);
  await real([["SET", "other:not-ours", "kept"]]);
  is("three records, both notes", [await exists("nl:test:fa:a"), await exists("nl:test:fa:b"), await exists("nl:test:fa:old-kind"), await exists(indexKey), await exists(notesKey)], [true, true, true, true, true]);
  const count = await forgetNoted(STATS, PERSON);
  is("answers the records deleted, each once (index and notes not counted)", count, 3);
  is("every noted record is gone", [await exists("nl:test:fa:a"), await exists("nl:test:fa:b"), await exists("nl:test:fa:old-kind")], [false, false, false]);
  is("both notes are gone", [await exists(indexKey), await exists(notesKey)], [false, false]);
  is("a member that is not an nl: key is never deleted", await exists("other:not-ours"), true);
  is("no stats id: 0, Redis not asked", await forgetNoted(null, PERSON), 0);

  part("as Redis counts: a missing note is not a key, and a key of another type is refused before any delete");
  await write("nl:test:fa:one");
  is("one record noted in the scored note only: 1", await forgetNoted(STATS, PERSON), 1);
  await write("nl:test:fa:noted-gone");
  await real([["DEL", "nl:test:fa:noted-gone"]]);
  is("a note whose record already expired: the note goes, 0 records", [await forgetNoted(STATS, PERSON), await exists(notesKey)], [0, false]);
  is("nothing noted: 0", await forgetNoted(STATS, PERSON), 0);
  await write("nl:test:fa:kept");
  await real([["SET", indexKey, "not a set"]]);
  is("an index of another type: Redis refuses, the step fails", await rejects(() => forgetNoted(STATS, PERSON)), "Error");
  is("and nothing was deleted: the notes, the index and the record kept", [await exists(notesKey), await exists(indexKey), await exists("nl:test:fa:kept")], [true, true, true]);
  await real([["DEL", indexKey, notesKey, "nl:test:fa:kept"]]);
  for (let i = 0; i < 2500; i += 250) {
    await real(Array.from({ length: 250 }, (_, j) => ["SET", `nl:test:fa:many-${i + j}`, "{}"]));
    await real(Array.from({ length: 250 }, (_, j) => noteForErasure(STATS, PERSON, `nl:test:fa:many-${i + j}`, Date.now() + i + j)).flat());
  }
  is("2,500 noted records: all deleted, counted once each", [await forgetNoted(STATS, PERSON), await exists("nl:test:fa:many-0"), await exists("nl:test:fa:many-2499"), await exists(notesKey)], [2500, false, false, false]);

  part("a reply not in its exact shape: the step fails, never 'nothing to delete'");
  const BAD: unknown[] = [undefined, null, "OK", 0, 2, {}, [], [1], [1, 1, 0], ["1", "0"], [-1, 0], [1.5, 0], [Number.NaN, 0], [null, 0], [1, 3], [0, 1], [1, -1], { 0: 1, 1: 0 }];
  for (const bad of BAD) {
    await write("nl:test:fa:shape");
    redis.pipeline = async (commands: Command[]) => (await real(commands)).map((reply, i) => (touchesIndex([commands[i]]) ? bad : reply));
    const answer = await rejects(() => forgetNoted(STATS, PERSON));
    restore();
    is(`answered ${JSON.stringify(bad) ?? "nothing"}: UnknownReplyError`, answer, "UnknownReplyError");
  }
  await write("nl:test:fa:shape");
  redis.pipeline = async (commands: Command[]) => (touchesIndex(commands) ? (await real(commands), []) : real(commands));
  is("no reply for the step: UnknownReplyError", await rejects(() => forgetNoted(STATS, PERSON)), "UnknownReplyError");
  await write("nl:test:fa:shape");
  redis.pipeline = async (commands: Command[]) => (touchesIndex(commands) ? [...(await real(commands)), [1, 1]] : real(commands));
  is("one reply too many: UnknownReplyError", await rejects(() => forgetNoted(STATS, PERSON)), "UnknownReplyError");
  restore();
  redis.pipeline = async () => {
    throw new Error("network");
  };
  is("a pipeline that throws: the step fails", await rejects(() => forgetNoted(STATS, PERSON)), "Error");
  restore();

  done();
}

void main();
