/**
 * Rule 24 / MR: how many bytes "what buyers bought next" holds (lib/next-bought.ts, pathsBytes) sizes the units held
 * before the API reads it (lib/mcp-tools.ts, boughtNextWork). STRLEN answers a whole number from 0 up (0 for no key):
 * null, "", a list or a reply cut short is unknown (null), never 0 bytes, which held fewer units than the read takes.
 *
 * Synthetic store only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pathsBytes } from "@/lib/next-bought";
import { store as redis } from "./redis-stub";

const STATS = "0123456789abcdef0123456789abcdee";
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

async function answered(reply: unknown[]): Promise<number | null> {
  redis.pipeline = (async (batch: Batch) => (batch.length === 1 && batch[0][0] === "STRLEN" ? reply : pipeline(batch))) as typeof redis.pipeline;
  try {
    return await pathsBytes(STATS);
  } finally {
    redis.pipeline = pipeline;
  }
}

test("an exact count is the size, and no key is 0", async () => {
  redis.clear();
  assert.equal(await pathsBytes(STATS), 0);
  assert.equal(await answered([1234]), 1234);
});

for (const [label, reply] of [
  ["null", [null]],
  ["empty text", [""]],
  ["a list", [[]]],
  ["text digits", ["12"]],
  ["no reply", []],
  ["two replies", [1, 2]],
] as [string, unknown[]][]) {
  test(`${label}: unknown, never 0 bytes`, async () => {
    assert.equal(await answered(reply), null);
  });
}
