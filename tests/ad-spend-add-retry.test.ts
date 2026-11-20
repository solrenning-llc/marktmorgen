/**
 * An ad spend line added while the Meta read fails is never kept twice (review of #4027, Claude 3, MEDIUM 1).
 *
 * addSpend wrote the typed line and then read every line back, the Meta ones included; a Meta read that failed made
 * the add throw after the line was kept, so the creator was told it failed and adding it again kept a second copy:
 * every figure that uses spend counted it twice. Since the merge of main's #2924 design into #4027, a failed Meta
 * read never makes the add or the removal fail: the one line is kept (or removed) and told so, with Meta's lines
 * said to be unread (metaUnread), never left out as $0. So nothing is ever done and told as failed.
 *
 * Synthetic data only; real MemoryRedis, with the Meta read made to fail.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addSpend, readSpendLines, removeSpend } from "@/lib/ad-spend";
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

test("an add while Meta cannot be read keeps the one line and says so, never told as failed", async () => {
  connected();
  const added = await metaFailing(() => addSpend(statsId, line, NOW));
  assert.notEqual(added, "failed", "a line that is kept is never told as failed");
  assert.ok(added !== "failed" && added.ok && added.metaUnread, "Meta's lines are said to be unread, not taken as none");
  assert.equal(kept(), 1, "the one line is kept, once");
  assert.deepEqual((await readSpendLines(statsId)).spends.map((s) => s.cents).sort((a, b) => a - b), [1_000, 50_000]);
});

test("a removal while Meta cannot be read is done and told as done", async () => {
  connected();
  const added = await addSpend(statsId, line, NOW);
  assert.ok(added.ok);
  const id = added.ok ? added.spends.find((s) => s.cents === 1_000)?.id : undefined;
  assert.ok(id);
  const removed = await metaFailing(() => removeSpend(statsId, id));
  assert.notEqual(removed, "failed", "a removal that happened is never told as failed");
  assert.ok(removed !== "failed" && removed.ok && removed.metaUnread, "Meta's lines are said to be unread");
  assert.equal(kept(), 0, "the line is removed");
  assert.deepEqual((await readSpendLines(statsId)).spends.map((s) => s.cents), [50_000]);
});
