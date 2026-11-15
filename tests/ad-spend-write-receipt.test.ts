/**
 * Codex Z's focal return on #2924 (rule 24), synthetic data only: a typed spend line's write is believed only from
 * its exact receipt. A receipt lost after the write was applied, or a receipt in another shape, is never "saved" and
 * never left behind a refusal for the same expense to be saved again: the line written under this add's own fresh id
 * is deleted by that id with a confirmed HDEL, and the add is refused ("unavailable": nothing saved, safe to try
 * again). When even that deletion is unconfirmed, the outcome is unknown and said so (UnknownReplyError, "unread":
 * reload to see where it stands), never "saved" and never "not saved". Lines already kept are never touched.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addSpend } from "@/lib/ad-spend";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const SID = "write-receipt-test";
const KEY = `nl:stats:${SID}:spend`;
const today = new Date().toISOString().slice(0, 10);
const LINE = { channel: "instagram", campaign: "", cents: 1200, from: today, to: today };
const KEPT = { channel: "facebook", campaign: "", cents: 700, from: today, to: today };

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

/** The cents of every typed line kept, read straight from the stub. */
async function rows(): Promise<number[]> {
  const [raw] = await real([["HGETALL", KEY]]);
  return (raw as string[]).filter((_, i) => i % 2 === 1).map((text) => (JSON.parse(text) as { cents: number }).cents).sort((a, b) => a - b);
}

/** Runs `run` with the write's pipeline (the one holding HSET) answered by `answer` after, or instead of, applying it. */
async function withWrite<T>(answer: (commands: Command[]) => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => (commands.some((c) => c[0] === "HSET") ? answer(commands) : real(commands))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

test("control: a healthy add records one line, confirmed", async () => {
  redis.clear();
  const result = await addSpend(SID, LINE);
  assert.equal(result.ok, true);
  assert.deepEqual(await rows(), [1200]);
});

test("a receipt lost after the write was applied refuses the add with nothing saved, so the retry records the expense once", async () => {
  redis.clear();
  const first = await withWrite(async (commands) => {
    await real(commands);
    throw new Error("synthetic: the write was applied and its receipt lost");
  }, () => addSpend(SID, LINE));
  assert.deepEqual(first, { ok: false, reason: "unavailable" }, "a lost receipt is never saved success");
  assert.deepEqual(await rows(), [], "a refusal means nothing was saved");
  const retry = await addSpend(SID, LINE);
  assert.equal(retry.ok, true);
  assert.deepEqual(await rows(), [1200], "one real expense stays one after the retry");
});

test("a write not applied, with an empty receipt, is never reported saved", async () => {
  redis.clear();
  const result = await withWrite(async () => [], () => addSpend(SID, LINE));
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
  assert.deepEqual(await rows(), []);
});

for (const [name, receipt] of [
  ["one reply for two commands", (r: unknown[]) => r.slice(0, 1)],
  ["an extra reply", (r: unknown[]) => [...r, 1]],
  ["the HSET count as text", (r: unknown[]) => [String(r[0]), r[1]]],
  ["the HSET count as 0", (r: unknown[]) => [0, r[1]]],
  ["the EXPIRE answer as 0", (r: unknown[]) => [r[0], 0]],
  ["no list at all", () => null],
] as [string, (r: unknown[]) => unknown][]) {
  test(`an applied write answered with ${name} is undone by its own id and refused, keeping the lines kept before`, async () => {
    redis.clear();
    await addSpend(SID, KEPT);
    const result = await withWrite(async (commands) => receipt((await real(commands)) as unknown[]), () => addSpend(SID, LINE));
    assert.deepEqual(result, { ok: false, reason: "unavailable" });
    assert.deepEqual(await rows(), [700], "the line kept before stays; the unconfirmed one is gone");
    assert.equal((await addSpend(SID, LINE)).ok, true);
    assert.deepEqual(await rows(), [700, 1200], "the retry adds it once");
  });
}

test("when the undoing deletion is unconfirmed too, the outcome is unknown: never saved success, never 'nothing saved'", async () => {
  redis.clear();
  await addSpend(SID, KEPT);
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    if (commands.some((c) => c[0] === "HSET")) throw new Error("synthetic: receipt lost");
    if (commands.length === 1 && commands[0][0] === "HDEL") return [];
    return replies;
  }) as typeof redis.pipeline;
  try {
    await assert.rejects(addSpend(SID, LINE), (error: unknown) => error instanceof UnknownReplyError);
  } finally {
    redis.pipeline = real;
  }
  assert.deepEqual(await rows(), [700], "the line kept before is never deleted by the undoing");
});
