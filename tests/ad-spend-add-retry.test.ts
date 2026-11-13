/**
 * An ad spend line added while the Meta read fails is never kept twice (review of #4027, Claude 3, MEDIUM 1).
 *
 * addSpend wrote the typed line and then read every line back, the Meta ones included (readSpends); since #4027 a
 * Meta read that fails throws instead of answering the typed lines alone. The line was then kept but the creator was
 * told the add failed, and adding it again kept a second copy: every figure that uses spend counted it twice. The Meta
 * lines are now read, exactly, before anything is written: a failed read writes nothing, and the retry adds the one
 * line. removeSpend reads them first too, so a removal is never told as failed after it was done.
 *
 * Synthetic data only; real MemoryRedis, with the Meta read made to fail.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addSpend, removeSpend } from "@/lib/ad-spend";
import { linesKey } from "@/lib/meta-ads";
import { store as redis } from "./redis-stub";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const real = redis.pipeline.bind(redis) as Pipeline;
const statsId = "adspendaddretry00000000000001";
const spendKey = `nl:stats:${statsId}:spend`;
const line = { channel: "google", campaign: "", cents: 1_000, from: "2026-11-01", to: "2026-11-07" };
const NOW = Date.parse("2026-11-10T12:00:00Z");

function connected(): void {
  redis.clear();
  redis.run(["SET", `nl:metaads:conn:${statsId}`, "{}"]);
  redis.run(["SET", linesKey(statsId), JSON.stringify([{ id: "meta-0123456789ab", channel: "meta", campaign: "Fall", cents: 50_000, from: "2026-11-01", to: "2026-11-07" }])]);
}
/** The Meta read (its EXISTS of the connection) fails while this runs. */
async function metaFailing<T>(work: () => Promise<T>): Promise<T | "failed"> {
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    if (commands.some(([name]) => name === "EXISTS")) throw new Error("Redis request timed out (test)");
    return real(commands);
  };
  try {
    return await work();
  } catch {
    return "failed";
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = real;
  }
}
const kept = () => (redis.run(["HLEN", spendKey]) as number) ?? 0;

test("an add told as failed keeps nothing, and the retry keeps the one line", async () => {
  connected();
  assert.equal(await metaFailing(() => addSpend(statsId, line, NOW)), "failed");
  assert.equal(kept(), 0, "nothing is kept when the add is told as failed");
  const again = await addSpend(statsId, line, NOW);
  assert.ok(again.ok);
  assert.equal(kept(), 1, "the retry keeps one line, not two");
  assert.deepEqual(again.ok && again.spends.map((s) => s.cents).sort((a, b) => a - b), [1_000, 50_000]);
});

test("a removal told as failed removed nothing", async () => {
  connected();
  const added = await addSpend(statsId, line, NOW);
  assert.ok(added.ok);
  const id = added.ok ? added.spends.find((s) => s.cents === 1_000)?.id : undefined;
  assert.ok(id);
  assert.equal(await metaFailing(() => removeSpend(statsId, id)), "failed");
  assert.equal(kept(), 1, "a removal told as failed did not happen");
  assert.deepEqual((await removeSpend(statsId, id)).map((s) => s.cents), [50_000]);
  assert.equal(kept(), 0);
});
