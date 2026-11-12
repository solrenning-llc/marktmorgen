/** Exercise the real queued worker: unknown erasure evidence must not permit email. */
import assert from "node:assert/strict";
import test from "node:test";
import { advanceUpdate, readUpdateJob, startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { suppressCommand } from "@/lib/suppression";
import { usedThisMonth } from "@/lib/mail";
import { windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const person = "update-person@example.test";
async function setup() {
  redis.clear();
  const owner = "update-owner@example.test";
  const batches: { to: string | string[] }[][] = [];
  let productId = "";
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body));
      batches.push(batch);
      return Response.json({ data: batch.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) });
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    const data = url.pathname === "/v1/checkout/sessions" ? [{
      id: "cs_update_evidence", object: "checkout.session", status: "complete", payment_status: "paid",
      created: Math.floor(Date.now() / 1000) - 86400, amount_total: 2700, currency: "usd",
      customer_details: { email: person }, metadata: { store: "updateproof", product: productId },
    }] : [];
    return Response.json({ object: "list", data, has_more: false });
  }) as typeof fetch;
  await claimHandle(owner, "updateproof", "Update Proof", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_UpdateProof", subscriptionId: "sub_UpdateProof", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Update Proof", address: "1 Example St, Example City" });
  const made = await addProduct(owner, "Update evidence", "", "27", null);
  assert.ok(made.ok);
  productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/update");
  const shop = (await storeForEmail(owner))!;
  const product = (await readListing(shop, productId))!;
  const started = await startUpdate(shop, product, "A verified update");
  assert.ok(started.ok, JSON.stringify(started));
  return { shop, job: started.job, batches, original: redis.pipeline.bind(redis) };
}

const unknown: [string, unknown[]][] = [
  ["empty", []], ["short", [0, null]], ["missing suppression", [0, null, undefined]],
  ["extra", [0, null, 0, 0]], ["null opt-out", [null, null, 0]],
  ["string opt-out", ["0", null, 0]], ["negative opt-out", [-1, null, 0]],
  ["null suppression", [0, null, null]], ["string suppression", [0, null, "0"]],
  ["object suppression", [0, null, {}]], ["false suppression", [0, null, false]],
  ["invalid contact", [0, "{", 0]], ["object contact", [0, {}, 0]],
  ["primitive contact", [0, '"contact"', 0]], ["array contact", [0, "[]", 0]],
  ["wrong opt-out field", [0, '{"unsub":"true"}', 0]],
  ["sparse", Object.assign(new Array(3), { 0: 0, 1: null })],
];
for (const [name, reply] of unknown) {
  test(`${name} recipient evidence keeps an erased buyer pending without email or allowance use`, async () => {
    const oldFetch = globalThis.fetch;
    const r = await setup();
    redis.run(suppressCommand(r.shop.listId!, person));
    const before = await usedThisMonth(r.shop.listId, windowId(r.shop));
    redis.pipeline = async commands => commands.some(c => c[0] === "HEXISTS" && c[1] === `nl:erased:${r.shop.listId}`) ? reply : r.original(commands);
    try {
      const held = await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000);
      assert.deepEqual([held?.status, held?.done, held?.sent], ["waiting", 0, 0]);
      assert.equal(r.batches.length, 0, "no email was posted while erasure evidence was unknown");
      assert.equal(await usedThisMonth(r.shop.listId, windowId(r.shop)), before);
      assert.deepEqual([(await readUpdateJob(r.job.id))?.done, redis.run(["LRANGE", `nl:upd:job:${r.job.id}:to`, 0, -1])], [0, [person]]);
      redis.pipeline = r.original;
      const recovered = await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000);
      assert.deepEqual([recovered?.status, recovered?.done, recovered?.sent], ["sent", 1, 0]);
      assert.equal(r.batches.length, 0, "confirmed erasure is still excluded after recovery");
    } finally { redis.pipeline = r.original; globalThis.fetch = oldFetch; }
  });
}

test("complete evidence still sends a permitted buyer exactly once", async () => {
  const oldFetch = globalThis.fetch;
  const r = await setup();
  try {
    const result = await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000);
    assert.deepEqual([result?.status, result?.done, result?.sent], ["sent", 1, 1]);
    assert.deepEqual(r.batches.flat().flatMap(m => m.to), [person]);
    await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000);
    assert.equal(r.batches.flat().length, 1);
  } finally { redis.pipeline = r.original; globalThis.fetch = oldFetch; }
});

const unknownQueues: [string, unknown[] | "throw"][] = [
  ["missing envelope", []], ["null list", [null]], ["missing list", [undefined]],
  ["scalar list", [0]], ["empty unfinished list", [[]]], ["extra envelope", [[person], null]],
  ["extra address", [[person, "extra@example.test"]]], ["non-string address", [[7]]],
  ["invalid address", [["not-an-address"]]], ["sparse list", [new Array(1)]],
  ["throwing queue read", "throw"],
];
for (const [name, reply] of unknownQueues) test(`${name} retains the real pending queue for a confirmed retry`, async () => {
  const oldFetch = globalThis.fetch;
  const r = await setup();
  const key = `nl:upd:job:${r.job.id}:to`;
  redis.pipeline = async commands => {
    if (commands.some(c => c[0] === "LRANGE" && c[1] === key)) {
      if (reply === "throw") throw new Error("synthetic queue read failed");
      return reply;
    }
    return r.original(commands);
  };
  try {
    const held = await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000);
    assert.deepEqual([held?.status, held?.done, held?.sent], ["waiting", 0, 0]);
    assert.deepEqual(redis.run(["LRANGE", key, 0, -1]), [person]);
    assert.equal(r.batches.length, 0);
    redis.pipeline = r.original;
    const recovered = await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000);
    assert.deepEqual([recovered?.status, recovered?.done, recovered?.sent], ["sent", 1, 1]);
    assert.equal(r.batches.flat().length, 1);
  } finally { redis.pipeline = r.original; globalThis.fetch = oldFetch; }
});
