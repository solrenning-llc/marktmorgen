/**
 * Rule 24 in a licence-key upload (CX-123; the coordinator's sweep of `Number(x) || 0`, 16 November 2026).
 *
 * addKeys put each key in the record of every key the product ever had (SADD) and read the answer as
 * `Number(fresh[j]) !== 1`: an answer that did not read was "already added", so a key that was in fact written to the
 * record never reached the pool, and every later upload of it said "already added or given before". The key was lost
 * to the creator, and its room was given back while the record still held it. Now each SADD is read exactly: on an
 * answer that does not read, the batch's new keys are taken back out of the record (SREM, read exactly), their room
 * given back, and the upload answers unknown, so the same keys can be uploaded again. The pool's and the cleared
 * pool's lengths are read exactly too: unknown is null, never 0.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { addKeys, clearPool } from "@/lib/licence-keys";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Cmd = (string | number)[];
const OWNER = "owner@keyr24.example";
process.env.STRIPE_SECRET_KEY = "sk_test_key_r24_only_a_stand_in";
const original = redis.pipeline.bind(redis);
let bend: ((commands: Cmd[], real: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (commands: Cmd[]) => {
  const real = (await original(commands)) as unknown[];
  return bend ? bend(commands, real) : real;
}) as typeof redis.pipeline;

async function setUp() {
  redis.clear();
  await claimHandle(OWNER, "keyr24", "Key R24", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestKeyR24001", true);
  await setSubscription(OWNER, { customerId: "cus_KeyR2400001", subscriptionId: "sub_KeyR2400001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Plugin", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/plugin");
  assert.ok((await setProductKeys(OWNER, made.product.id, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 0 })).ok);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readProduct(store, made.product.id))!;
  return { store, product, pool: `nl:keys:${store.statsId}:${product.id}:pool` };
}
const keys = ["AAAA-BBBB-CCCC-DDD1", "AAAA-BBBB-CCCC-DDD2"];

for (const value of ["QUEUED", null, "1", { error: "ERR synthetic" }]) {
  test(`an SADD answered ${JSON.stringify(value)} is unknown, and the keys can be uploaded again`, async () => {
    const { store, product, pool } = await setUp();
    // The first key's SADD is written but answers in another shape.
    bend = (commands, real) => real.map((r, i) => (commands[i][0] === "SADD" && commands[i][2] === keys[0] ? value : r));
    await assert.rejects(addKeys(store, product, keys), { name: "UnknownReplyError" });
    bend = null;
    assert.equal(redis.run(["LLEN", pool]), 0, "nothing reached the pool");
    const again = await addKeys(store, product, keys);
    assert.equal(again.added, 2, "both keys go in on the next upload, never 'already added'");
    assert.equal(again.known, 0);
  });
}

test("the pool's length that does not read is null, never 0", async () => {
  const { store, product } = await setUp();
  bend = (commands, real) => real.map((r, i) => (commands[i][0] === "LLEN" ? "QUEUED" : r));
  const result = await addKeys(store, product, keys);
  bend = null;
  assert.equal(result.added, 2);
  assert.equal(result.left, null);
});

test("a cleared pool's length that does not read is null, never 0", async () => {
  const { store, product, pool } = await setUp();
  await addKeys(store, product, keys);
  bend = (commands, real) => real.map((r, i) => (commands[i][0] === "LLEN" ? "QUEUED" : r));
  const removed = await clearPool(store, product);
  bend = null;
  assert.equal(removed, null);
  assert.equal(redis.run(["LLEN", pool]), 0, "the pool is still cleared");
});

test("control: real replies add, count and clear", async () => {
  const { store, product } = await setUp();
  const first = await addKeys(store, product, keys);
  assert.deepEqual([first.added, first.known, first.left], [2, 0, 2]);
  const second = await addKeys(store, product, keys);
  assert.deepEqual([second.added, second.known], [0, 2]);
  assert.equal(await clearPool(store, product), 2);
});
