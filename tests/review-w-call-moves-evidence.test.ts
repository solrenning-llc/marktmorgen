/** Review-only RED proof. No implementation change or product PR. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readMoves } from "@/lib/call-records";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
afterEach(() => { redis.pipeline = pipeline; });
const session = "cs_test_123456789012345678901234";

for (const [label, reply] of Object.entries({
  missingPipeline: [], missingMove: [[]], outerExtra: [[null], null],
  undefinedMove: [[undefined]], nonStringMove: [[1]], unreadableMove: [["{broken"]],
})) {
  test(`unknown move evidence must not restore the original booking time: ${label}`, async () => {
    redis.pipeline = (async () => reply as never) as typeof redis.pipeline;
    await assert.rejects(readMoves([session]), "unknown must not be returned as no move");
  });
}

test("explicit null alone confirms that no move is stored", async () => {
  redis.pipeline = (async () => [[null]]) as typeof redis.pipeline;
  assert.equal((await readMoves([session])).size, 0);
});

test("a confirmed stored move keeps the new busy interval", async () => {
  const move = { s: 1_800_000_000_000, e: 1_800_003_600_000, n: 1 };
  redis.pipeline = (async () => [[JSON.stringify(move)]]) as typeof redis.pipeline;
  assert.deepEqual((await readMoves([session])).get(session), move);
});
