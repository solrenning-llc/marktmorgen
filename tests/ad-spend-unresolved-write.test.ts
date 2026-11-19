/**
 * Codex Z's focal on #2924 at 206cb7471 (conditional MEDIUM): when the write's round trip itself fails, whether that
 * write will still land is not known; a cleanup HDEL that answers 0 proves only that it has not landed yet, never that
 * it never will. So such an add is never answered "That did not save. Try again." (unavailable): it is unknown
 * (UnknownReplyError, the route's "unread": reload to see where it stands). Only a cleanup that removed the line (1),
 * or a write that answered in some shape (it ran), still lets the add be refused as nothing saved. Synthetic data
 * only; a deferred completion is modeled by holding the write's commands and running them later.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addSpend } from "@/lib/ad-spend";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const SID = "unresolved-write-test";
const KEY = `nl:stats:${SID}:spend`;
const today = new Date().toISOString().slice(0, 10);
const LINE = { channel: "instagram", campaign: "", cents: 1200, from: today, to: today };

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
async function rows(): Promise<number[]> {
  const [raw] = await real([["HGETALL", KEY]]);
  return (raw as string[]).filter((_, i) => i % 2 === 1).map((text) => (JSON.parse(text) as { cents: number }).cents);
}
async function withWrite<T>(answer: (commands: Command[]) => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => (commands.some((c) => c[0] === "HSET") ? answer(commands) : real(commands))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

test("a write whose round trip failed and that has not landed yet is unknown, never 'nothing saved'", async () => {
  redis.clear();
  const pending: Command[][] = [];
  const outcome = await withWrite(async (commands) => {
    pending.push(commands);
    throw new Error("synthetic: the client gave up; whether the write completes is unresolved");
  }, () => addSpend(SID, LINE).then((result) => result, (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : error)));
  assert.equal(outcome, "unknown", "an unresolved write is never answered as known not saved");
  assert.deepEqual(await rows(), [], "nothing has landed yet");
  // Completing late, it is one line, and the creator was told to reload and see it, not to type it again.
  for (const commands of pending) await real(commands);
  assert.deepEqual(await rows(), [1200]);
});

test("control: a write whose round trip failed after it landed is removed by its own id and refused as nothing saved", async () => {
  redis.clear();
  const result = await withWrite(async (commands) => {
    await real(commands);
    throw new Error("synthetic: the write was applied and its receipt lost");
  }, () => addSpend(SID, LINE));
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
  assert.deepEqual(await rows(), []);
});

test("control: a write that answered in another shape ran, and is refused as nothing saved", async () => {
  redis.clear();
  const result = await withWrite(async () => [], () => addSpend(SID, LINE));
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
  assert.deepEqual(await rows(), []);
});

test("control: a healthy add is saved once", async () => {
  redis.clear();
  assert.equal((await addSpend(SID, LINE)).ok, true);
  assert.deepEqual(await rows(), [1200]);
});
