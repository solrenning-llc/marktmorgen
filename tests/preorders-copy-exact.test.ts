/**
 * Rule 24: a person's pre-orders, read for the copy of their data (lib/preorders.ts, preordersOf; 619 [SZ3]), are read
 * exactly. One HGETALL a product: a reply cut short, one too many, a list of another shape (not text, an odd count) or
 * an entry that does not read throws UnknownReplyError, so the whole copy fails and is tried again (lib/person-copy.ts)
 * instead of being handed over without the pre-orders as if the person had none.
 *
 * Synthetic store, products and entries only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { preordersOf } from "@/lib/preorders";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const SID = "abcdefabcdefabcdefabcdefabcdef12";
const store = { sid: "sidpreorders01", statsId: SID } as unknown as Store;
const products = ["prodpre00001", "prodpre00002"];
const EMAIL = "pre@example.com";
const entry = (to: string) => JSON.stringify({ to, at: 1_780_000_000, pi: "pi_pre0001" });
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

redis.clear();
const fixture = (async () => {
  await pipeline([
    ["HSET", `nl:pre:${SID}:${products[0]}`, "cs_test_pre0001", entry(EMAIL), "cs_test_pre0002", entry("other@example.com")],
    ["HSET", `nl:pre:${SID}:${products[1]}`, "cs_test_pre0003", entry(EMAIL)],
  ]);
})();

async function answered(alter: (real: unknown[]) => unknown[]): Promise<{ value?: unknown; error?: unknown }> {
  redis.pipeline = (async (batch: Batch) => {
    const real = await pipeline(batch);
    return batch.every((c) => c[0] === "HGETALL" && String(c[1]).startsWith(`nl:pre:${SID}:`)) ? alter(real) : real;
  }) as typeof redis.pipeline;
  try {
    return { value: await preordersOf(store, products, EMAIL) };
  } catch (error) {
    return { error };
  } finally {
    redis.pipeline = pipeline;
  }
}

test("read exactly, the person's own pre-orders and no one else's", async () => {
  await fixture;
  const mine = await preordersOf(store, products, EMAIL);
  assert.deepEqual(mine.map((p) => [p.product, p.checkout]), [[products[0], "cs_test_pre0001"], [products[1], "cs_test_pre0003"]]);
});

for (const [label, alter] of [
  ["no replies", () => []],
  ["one reply short", (r: unknown[]) => r.slice(0, 1)],
  ["one reply too many", (r: unknown[]) => [...r, []]],
  ["a number for a product", (r: unknown[]) => [r[0], 7]],
  ["null for a product", (r: unknown[]) => [r[0], null]],
  ["an odd count of fields", (r: unknown[]) => [r[0], [...(r[1] as unknown[]), "cs_test_extra"]]],
  ["a field that is not text", (r: unknown[]) => [r[0], [1, entry(EMAIL)]]],
  ["an entry that does not read", (r: unknown[]) => [r[0], ["cs_test_pre0003", "{not json"]]],
] as [string, (r: unknown[]) => unknown[]][]) {
  test(`${label}: throws, never a copy without the pre-orders`, async () => {
    await fixture;
    const result = await answered(alter);
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  });
}

test("an exact empty hash is still none", async () => {
  await fixture;
  assert.deepEqual(await preordersOf(store, ["prodpre00009"], EMAIL), []);
});
