/**
 * forgetNoted (lib/erasure-index.ts) deletes an address's notes, with every record they name, only while the notes
 * still hold exactly what it read (disclosed on #3296, comment 6728207094).
 *
 * As a read (SMEMBERS, ZRANGEBYSCORE) and then a plain DEL, a writer that notes its record with noteForErasure between
 * them was lost: the read missed the new key, the DEL took the notes with the new key's entry in them, and the new
 * record, holding the erased buyer's address, was left with no note, so no later erasure could find it. Now the
 * delete is one script naming every key it touches (FORGET_NOTED); it deletes nothing and answers "changed" when a
 * note moved, and the erasure reads again, at most FORGET_TRIES times.
 *
 * Held here:
 *   - a writer's note landing between the read and the delete: the erasure reads again and deletes that record too;
 *     notes that keep changing fail the step (UnknownReplyError) with nothing deleted;
 *   - the healthy erasure deletes every noted record (both kinds of note) and the notes, and answers the same count
 *     as before; what does not start with "nl:" is never deleted; nothing noted, or no stats id, answers 0;
 *   - more than FORGET_KEYS records: deleted in batches, each record with its own note entries, a note added meanwhile
 *     included, all counted once;
 *   - a reply not in its exact shape throws UnknownReplyError, never "nothing to delete"; a note Redis refuses to read
 *     deletes nothing.
 *
 * Synthetic only: the Redis stand-in (lib/redis-memory.ts), which runs the scripts step for step. Its plain SMEMBERS
 * and ZRANGEBYSCORE make an empty set or sorted set when the key is missing, and take a key of another type as an
 * empty one (tests/sg2-unknown-replies.test.ts, part 4, says the same of its DEL count); Redis does neither. The
 * scripts' model counts as Redis does, so the part "as Redis counts" holds for the scripts: on the old plain DEL those
 * counts came out one or two too high in the stand-in, never in Redis. Where Redis would refuse a plain read of a key
 * of another type, the test makes the stand-in refuse it too.
 */
import { createHash } from "node:crypto";
import { FORGET_KEYS, FORGET_TRIES, forgetNoted, noteForErasure } from "@/lib/erasure-index";
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
const isRead = (commands: Command[]) => commands.some((c) => c[0] === "SMEMBERS" && c[1] === indexKey);
const isStep = (command: Command) => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:forget-noted:v2\n");
const rejects = (work: () => Promise<unknown>) =>
  work().then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.name : "thrown"),
  );

async function main(): Promise<void> {
  redis.clear();

  part("a writer's note landing between the read and the delete: the erasure reads again and deletes it too");
  await write("nl:test:fa:old-1");
  const late = "nl:test:fa:late-1";
  let landed = 0;
  // The writer runs right after the erasure's first read answers, before its delete.
  redis.pipeline = async (commands: Command[]) => {
    const replies = await real(commands);
    if (!landed && isRead(commands)) {
      landed += 1;
      await write(late);
    }
    return replies;
  };
  const raced = await forgetNoted(STATS, PERSON);
  restore();
  is("the writer did land between the read and the delete", landed, 1);
  is("the record that was there before is deleted", await exists("nl:test:fa:old-1"), false);
  is("the late record is deleted by the same erasure", await exists(late), false);
  is("and the notes are gone", await exists(notesKey), false);
  is("both records counted, each once", raced, 2);
  await forgetNoted(STATS, PERSON);
  is("a second erasure finds nothing left", await exists(late), false);

  part(`notes that change after every read: ${FORGET_TRIES} tries, then the step fails with nothing deleted`);
  await write("nl:test:fa:first");
  let lands = 0;
  redis.pipeline = async (commands: Command[]) => {
    const replies = await real(commands);
    if (isRead(commands)) {
      lands += 1;
      await write(`nl:test:fa:busy-${lands}`);
    }
    return replies;
  };
  const busy = await rejects(() => forgetNoted(STATS, PERSON));
  restore();
  is("it fails as not finished", [busy, lands], ["UnknownReplyError", FORGET_TRIES]);
  is("nothing was deleted: every record and the notes kept", [await exists("nl:test:fa:first"), await exists("nl:test:fa:busy-1"), await exists(`nl:test:fa:busy-${FORGET_TRIES}`), await exists(notesKey)], [true, true, true, true]);
  is("the next erasure deletes them all", [await forgetNoted(STATS, PERSON), await exists("nl:test:fa:first"), await exists(notesKey)], [FORGET_TRIES + 1, false, false]);

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

  part("as Redis counts: a missing note is not a key, and a note of another type is refused before any delete");
  await write("nl:test:fa:one");
  is("one record noted in the scored note only: 1", await forgetNoted(STATS, PERSON), 1);
  await write("nl:test:fa:noted-gone");
  await real([["DEL", "nl:test:fa:noted-gone"]]);
  is("a note whose record already expired: the note goes, 0 records", [await forgetNoted(STATS, PERSON), await exists(notesKey)], [0, false]);
  is("nothing noted: 0", await forgetNoted(STATS, PERSON), 0);
  await write("nl:test:fa:kept");
  await real([["SET", indexKey, "not a set"]]);
  // Redis refuses SMEMBERS on a string (WRONGTYPE); the stand-in's plain SMEMBERS would make it a set instead.
  redis.pipeline = async (commands: Command[]) => {
    if (isRead(commands) && (await real([["TYPE", indexKey]]))[0] === "string") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    return real(commands);
  };
  is("an index of another type: Redis refuses the read, the step fails", await rejects(() => forgetNoted(STATS, PERSON)), "Error");
  restore();
  is("and nothing was deleted: the notes, the index and the record kept", [await exists(notesKey), await exists(indexKey), await exists("nl:test:fa:kept")], [true, true, true]);
  await real([["DEL", indexKey]]);
  let swapped = false;
  redis.pipeline = async (commands: Command[]) => {
    const replies = await real(commands);
    if (!swapped && isRead(commands)) {
      swapped = true;
      await real([["SET", indexKey, "not a set"]]);
    }
    return replies;
  };
  is("an index turned to another type after the read: the script refuses, the step fails", await rejects(() => forgetNoted(STATS, PERSON)), "Error");
  restore();
  is("and nothing was deleted", [await exists(notesKey), await exists("nl:test:fa:kept")], [true, true]);
  await real([["DEL", indexKey, notesKey, "nl:test:fa:kept"]]);

  part(`more than ${FORGET_KEYS} records: in batches, each with its own note entries, all counted once`);
  for (let i = 0; i < 2500; i += 250) {
    await real(Array.from({ length: 250 }, (_, j) => ["SET", `nl:test:fa:many-${i + j}`, "{}"]));
    await real(Array.from({ length: 250 }, (_, j) => noteForErasure(STATS, PERSON, `nl:test:fa:many-${i + j}`, Date.now() + i + j)).flat());
  }
  let batched = 0;
  redis.pipeline = async (commands: Command[]) => {
    const replies = await real(commands);
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:forget-noted-part:v2\n")) && ++batched === 1) await write("nl:test:fa:during-batches");
    return replies;
  };
  const many = await forgetNoted(STATS, PERSON);
  restore();
  is("two batches, then the rest in the checked step", batched, 2);
  is("2,500 records and one noted during the batches: all deleted, each counted once", [many, await exists("nl:test:fa:many-0"), await exists("nl:test:fa:many-2499"), await exists("nl:test:fa:during-batches"), await exists(notesKey)], [2501, false, false, false, false]);

  part("an index turned to another type during the batches: refused before any delete");
  for (let i = 0; i < 1100; i += 275) {
    await real(Array.from({ length: 275 }, (_, j) => ["SET", `nl:test:fa:typed-${i + j}`, "{}"]));
    await real(Array.from({ length: 275 }, (_, j) => noteForErasure(STATS, PERSON, `nl:test:fa:typed-${i + j}`, Date.now() + i + j)).flat());
  }
  let typed = false;
  redis.pipeline = async (commands: Command[]) => {
    const replies = await real(commands);
    if (!typed && isRead(commands)) {
      typed = true;
      await real([["SET", indexKey, "not a set"]]);
    }
    return replies;
  };
  const typedAnswer = await rejects(() => forgetNoted(STATS, PERSON));
  restore();
  is("the batch is refused: the step fails as not finished", typedAnswer, "UnknownReplyError");
  is("and nothing was deleted: the records and the notes kept", [await exists("nl:test:fa:typed-0"), await exists("nl:test:fa:typed-999"), await exists(notesKey)], [true, true, true]);
  await real([["DEL", indexKey, notesKey], ...Array.from({ length: 1100 }, (_, i) => ["DEL", `nl:test:fa:typed-${i}`])]);

  // Codex Z on #3308 (review 5820151427): notes refilled by an overlapping writer after every batch, whose records
  // have already expired (each batch deletes 0), must stop at FORGET_BATCHES batches, never one more.
  part("notes refilled after every batch: at most 100 batches, then the step fails as not finished");
  const refill = Array.from({ length: FORGET_KEYS + 1 }, (_, i) => `nl:test:fa:refill-${i}`);
  let parts = 0;
  redis.pipeline = async (commands: Command[]) => {
    if (isRead(commands)) return [[], refill];
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:forget-noted-part:v2\n"))) {
      parts += 1;
      return [0];
    }
    return real(commands);
  };
  const refilled = await rejects(() => forgetNoted(STATS, PERSON));
  restore();
  is("the step fails as not finished, after exactly 100 batches", [refilled, parts], ["UnknownReplyError", 100]);

  part("a reply not in its exact shape: the step fails, never 'nothing to delete'");
  const BAD: unknown[] = [undefined, null, "OK", "Changed", 0, 2, {}, [], [1], [1, 1, 0], ["1", "0"], [-1, 0], [1.5, 0], [Number.NaN, 0], [null, 0], [1, 3], [0, 1], [1, 0], [1, 2], [5, 1], [1, -1], { 0: 1, 1: 0 }];
  for (const bad of BAD) {
    await write("nl:test:fa:shape");
    redis.pipeline = async (commands: Command[]) => (await real(commands)).map((reply, i) => (isStep(commands[i]) ? bad : reply));
    const answer = await rejects(() => forgetNoted(STATS, PERSON));
    restore();
    is(`the step answered ${JSON.stringify(bad) ?? "nothing"}: UnknownReplyError`, answer, "UnknownReplyError");
  }
  for (const bad of [undefined, null, "nl:x", {}, ["nl:x", 7], [null]]) {
    await write("nl:test:fa:read");
    redis.pipeline = async (commands: Command[]) => (await real(commands)).map((reply, i) => (commands[i][0] === "ZRANGEBYSCORE" && commands[i][1] === notesKey ? bad : reply));
    const answer = await rejects(() => forgetNoted(STATS, PERSON));
    restore();
    is(`the notes read as ${JSON.stringify(bad) ?? "nothing"}: fails, the notes and the record kept`, [answer, await exists(notesKey), await exists("nl:test:fa:read")], ["UnknownReplyError", true, true]);
  }
  redis.pipeline = async (commands: Command[]) => (commands.some(isStep) ? (await real(commands), []) : real(commands));
  is("no reply for the step: UnknownReplyError", await rejects(() => forgetNoted(STATS, PERSON)), "UnknownReplyError");
  await write("nl:test:fa:shape");
  redis.pipeline = async (commands: Command[]) => (commands.some(isStep) ? [...(await real(commands)), [1, 1]] : real(commands));
  is("one reply too many: UnknownReplyError", await rejects(() => forgetNoted(STATS, PERSON)), "UnknownReplyError");
  redis.pipeline = async () => {
    throw new Error("network");
  };
  is("a pipeline that throws: the step fails", await rejects(() => forgetNoted(STATS, PERSON)), "Error");
  restore();

  done();
}

void main();
