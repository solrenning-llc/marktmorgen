/**
 * Claude 5 on #2924, LEVE B: past MAX_SPEND_ENTRIES lines, addSpend prunes the oldest with one HDEL after the new
 * line is written. That HDEL failing (a network error) went up as a plain Error: the route answered 500 and the
 * editor said "That did not save. Try again." with the line already saved, so a changed form saved it twice. Now a
 * failed prune is logged and the add answers saved: the read is cut to the newest MAX_SPEND_ENTRIES, and the next add
 * prunes again. Synthetic data only, the Redis stub.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addSpend } from "@/lib/ad-spend";
import { MAX_SPEND_ENTRIES } from "@/lib/ad-spend-rules";
import { store as redis } from "./redis-stub";

const SID = "synthetic-spend-prune";
const KEY = `nl:stats:${SID}:spend`;
const OP = "0123456789abcdef0123456789abcdef";
const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function full(): Promise<void> {
  redis.clear();
  const fields: string[] = [];
  for (let i = 0; i < MAX_SPEND_ENTRIES; i += 1) fields.push(i.toString(16).padStart(8, "0"), JSON.stringify({ channel: "instagram", campaign: "", cents: 100, from: day(i), to: day(i) }));
  await real([["HSET", KEY, ...fields]]);
}

test("a prune that fails after the line is written still answers saved, never 'did not save'", async () => {
  await full();
  redis.pipeline = (async (commands: Command[]) => {
    if (commands[0]?.[0] === "HDEL" && commands[0][1] === KEY) throw new Error("socket closed");
    return real(commands);
  }) as typeof redis.pipeline;
  let answer: Awaited<ReturnType<typeof addSpend>> | Error;
  try {
    answer = await addSpend(SID, { channel: "tiktok", campaign: "", cents: 1200, from: today, to: today, op: OP }).catch((error: Error) => error);
  } finally {
    redis.pipeline = real;
  }
  assert.equal(answer instanceof Error, false, "no error reaches the route");
  assert.equal(!(answer instanceof Error) && answer.ok, true);
  const kept = (await real([["HGET", KEY, OP]]))[0];
  assert.equal(typeof kept, "string", "the line is saved");
});

test("control: with the prune answered, the oldest line goes and the add is saved", async () => {
  await full();
  const answer = await addSpend(SID, { channel: "tiktok", campaign: "", cents: 1200, from: today, to: today, op: OP });
  assert.equal(answer.ok, true);
  assert.equal((await real([["HEXISTS", KEY, "00000000"]]))[0], 0);
  assert.equal((await real([["HLEN", KEY]]))[0], MAX_SPEND_ENTRIES);
});
