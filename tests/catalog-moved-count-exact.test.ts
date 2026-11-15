/**
 * Rule 24 in the guard that refuses to write a lost product index over a store's products (lib/catalog.ts,
 * movedCount, read by moveToRecords in lib/store.ts): how many products the index listed when the catalog was last
 * written is read exactly. Only GET's exact null is "never moved" and only digits are a count; a reply cut short, of
 * another shape, or a value that is not a count throws, so nothing is written, never null or 0 that let an empty
 * index be written over the products.
 *
 * Synthetic catalog id only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { movedCount, movedMark } from "@/lib/catalog";
import { store as redis } from "./redis-stub";

const CATALOG = "a".repeat(32);
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

async function read(reply: unknown[] | null): Promise<string> {
  if (reply) redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "GET" ? reply : pipeline(b))) as typeof redis.pipeline;
  try {
    return JSON.stringify(await movedCount(CATALOG));
  } catch {
    return "threw";
  } finally {
    redis.pipeline = pipeline;
  }
}

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["an object", [{}]], ["text that is not a count", ["many"]], ["two replies", ["3", "4"]]] as [string, unknown[]][]) {
  test(`the count read as ${label} throws, never "never moved" or 0`, async () => {
    redis.clear();
    assert.equal(await read(reply), "threw");
  });
}

test("read exactly: never moved is null, a kept count is that count", async () => {
  redis.clear();
  assert.equal(await read(null), "null");
  await pipeline([movedMark(CATALOG, 12)]);
  assert.equal(await read(null), "12");
});
