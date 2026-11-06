/**
 * Proof (sweep A6, CX-123 rule 24): lib/stats-notes.ts addNote trims the list
 * past MAX_NOTES by keeping the ids readNotes returned and HDEL-ing every
 * other field. readNotes reads HGETALL with `Array.isArray(raw) ? raw : []`,
 * so an HGETALL reply of another shape is "no notes", the keep set is empty,
 * and every one of the creator's notes is deleted, the new one too.
 *
 * The "defect" test asserts the fail-closed behavior and FAILS ON PURPOSE on
 * main; the "control" passes. Synthetic records and the in-memory Redis only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_NOTES, addNote } from "@/lib/stats-notes";
import { store as redis } from "./redis-stub";

const NOW = Date.UTC(2026, 10, 6, 12);
const day = new Date(NOW - 86_400_000).toISOString().slice(0, 10);
const key = (statsId: string) => `nl:stats:${statsId}:notes`;
const fields = async (statsId: string) => Number((await redis.pipeline([["HLEN", key(statsId)]]))[0]);

async function seed(statsId: string) {
  const args: (string | number)[] = [];
  for (let i = 0; i < MAX_NOTES; i += 1) args.push(i.toString(16).padStart(8, "0"), JSON.stringify({ day, text: `Fictional note ${i}` }));
  await redis.pipeline([["HSET", key(statsId), ...args]]);
}

test("control: at MAX_NOTES + 1, one note goes and MAX_NOTES stay", async () => {
  redis.clear();
  await seed("sweepa6ok");
  await addNote("sweepa6ok", day, "One more", NOW);
  assert.equal(await fields("sweepa6ok"), MAX_NOTES);
});

test("defect: an HGETALL reply of another shape must not delete every note", async () => {
  redis.clear();
  await seed("sweepa6bad");
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0][0] === "HGETALL" ? [null] : original.call(redis, commands))) as typeof redis.pipeline;
  try { await addNote("sweepa6bad", day, "One more", NOW).catch(() => null); }
  finally { redis.pipeline = original; }
  const left = await fields("sweepa6bad");
  assert.ok(left >= MAX_NOTES, `expected the ${MAX_NOTES} notes kept on an unknown read; ${left} are left (all ${MAX_NOTES + 1} HDEL-ed)`);
});
