/**
 * Rule 24 in two reads behind a person's data copy (lib/person-copy.ts) and the store export (lib/store-export.ts):
 *
 *   - readForms (lib/form-store.ts): the store's forms (HVALS) read in another shape throw, never "this store has no
 *     forms", which left a person's form answers out of their copy and wrote "forms": [] into the export;
 *   - keysOf (lib/licence-keys.ts): each product's issued keys (HGETALL) read cut short, in another shape or with an
 *     odd count throw, never a copy without the person's license keys.
 *
 * Synthetic store only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readForms } from "@/lib/form-store";
import { keysOf } from "@/lib/licence-keys";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STATS = "0123456789abcdef0123456789abcd05";
const store = { statsId: STATS } as unknown as Store;
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

async function outcome(pick: (b: Batch) => boolean, alter: (real: unknown[]) => unknown[], run: () => Promise<unknown>): Promise<string> {
  redis.pipeline = (async (b: Batch) => {
    const real = await pipeline(b);
    return pick(b) ? alter(real) : real;
  }) as typeof redis.pipeline;
  try {
    return JSON.stringify(await run());
  } catch {
    return "threw";
  } finally {
    redis.pipeline = pipeline;
  }
}

const hvals = (b: Batch) => b.length === 1 && b[0][0] === "HVALS" && b[0][1] === `nl:forms:${STATS}`;
for (const [label, alter] of [["no reply", () => []], ["a number", () => [7]], ["null", () => [null]], ["a value that is not text", () => [[1]]]] as [string, (r: unknown[]) => unknown[]][]) {
  test(`readForms: the forms read as ${label} throw, never "no forms"`, async () => {
    redis.clear();
    assert.equal(await outcome(hvals, alter, () => readForms(STATS)), "threw");
  });
}

const getall = (b: Batch) => b.every((c) => c[0] === "HGETALL" && String(c[1]).endsWith(":info"));
for (const [label, alter] of [
  ["no replies", () => []],
  ["one reply short", (r: unknown[]) => r.slice(0, 1)],
  ["a number for a product", (r: unknown[]) => [r[0], 7]],
  ["an odd count", (r: unknown[]) => [r[0], ["k"]]],
] as [string, (r: unknown[]) => unknown[]][]) {
  test(`keysOf: the keys read as ${label} throw, never a copy without them`, async () => {
    redis.clear();
    assert.equal(await outcome(getall, alter, () => keysOf(store, ["prodkeys0001", "prodkeys0002"], "buyer@example.com")), "threw");
  });
}

test("read exactly, an empty store has no forms and no keys", async () => {
  redis.clear();
  assert.deepEqual(await readForms(STATS), []);
  assert.deepEqual(await keysOf(store, ["prodkeys0001", "prodkeys0002"], "buyer@example.com"), []);
});
