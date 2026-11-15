/**
 * A closing lets the buyers' told addresses go only on a confirmed DEL (#4755, Codex L). forgetTold sent DEL and
 * read no reply, so an empty or malformed answer let the closing go on to markDue and its removed state while the
 * hash of addresses was still in Redis. Only one reply whose count is 0 or 1 is now done; anything else throws
 * UnknownReplyError, so the next round deletes again. Synthetic folder; MemoryRedis.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { forgetTold, toldKey } from "@/lib/closing-buyers";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const folder = "codex-l-synthetic-closing";
const key = toldKey(folder);
const original = redis.pipeline.bind(redis);

function seedAndAnswer(reply: unknown): void {
  redis.clear();
  redis.pipeline = original;
  redis.run(["HSET", key, "buyer@example.test", "1700000000000"]);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0]?.[0] === "DEL" && commands[0]?.[1] === key) return reply;
    return original(commands);
  }) as typeof redis.pipeline;
}

for (const [label, reply] of [["no reply", []], ["text", ["OK"]], ["two replies", [1, 1]], ["a count above one", [2]], ["a negative count", [-1]], ["null", null]] as const) {
  test(`an unreadable DEL reply (${label}) throws and keeps the addresses`, async () => {
    seedAndAnswer(reply);
    await assert.rejects(() => forgetTold(folder), UnknownReplyError);
    redis.pipeline = original;
    assert.equal(redis.run(["HGET", key, "buyer@example.test"]), "1700000000000");
  });
}

test("a confirmed DEL (1, or 0 when already gone) is done", async () => {
  redis.clear();
  redis.pipeline = original;
  redis.run(["HSET", key, "buyer@example.test", "1700000000000"]);
  await forgetTold(folder);
  assert.equal(redis.run(["EXISTS", key]), 0);
  await forgetTold(folder);
});
