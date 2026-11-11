/** Exercise the real queued worker: unknown erasure evidence must not permit email. */
import assert from "node:assert/strict";
import test from "node:test";
import { advanceUpdate, advanceUpdates, startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
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


test("Q boundary healthy control: the real pending job sends once and leaves the worker queue", async () => {
  const priorFetch = globalThis.fetch;
  const r = await setup();
  try {
    assert.equal(redis.run(["SISMEMBER", "nl:updq", r.job.id]), 1);
    assert.equal(await advanceUpdates(storeForHandle, Date.now() + 20000), 1);
    assert.equal(r.batches.flat().length, 1);
    assert.equal(redis.run(["SISMEMBER", "nl:updq", r.job.id]), 0);
  } finally { redis.pipeline = r.original; globalThis.fetch = priorFetch; }
});

test("Q boundary confirmed absent job control can leave the worker queue", async () => {
  const priorFetch = globalThis.fetch;
  const r = await setup();
  try {
    redis.run(["DEL", `nl:upd:job:${r.job.id}`]);
    assert.equal(await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000), null);
    assert.equal(redis.run(["SISMEMBER", "nl:updq", r.job.id]), 0);
    assert.equal(r.batches.length, 0);
  } finally { redis.pipeline = r.original; globalThis.fetch = priorFetch; }
});

const unreadable: [string, (job: Awaited<ReturnType<typeof setup>>["job"]) => unknown[]][] = [
  ["undefined item", () => [undefined]], ["number item", () => [0]], ["object item", () => [{}]],
  ["sparse envelope", () => new Array(1)],
  ["inherited envelope", job => Object.assign(Object.create({ 0: JSON.stringify(job) }), { length: 1 })],
  ["JSON null", () => ["null"]], ["JSON array", () => ["[]"]], ["JSON primitive", () => ['"job"']],
  ["different id", job => [JSON.stringify({ ...job, id: "a".repeat(24) === job.id ? "b".repeat(24) : "a".repeat(24) })]],
  ["missing handle", job => [JSON.stringify({ ...job, handle: undefined })]],
  ["wrong statsId", job => [JSON.stringify({ ...job, statsId: false })]],
  ["missing product", job => [JSON.stringify({ ...job, product: undefined })]],
  ["wrong title", job => [JSON.stringify({ ...job, title: [] })]],
  ["wrong words", job => [JSON.stringify({ ...job, words: null })]],
  ["unknown status", job => [JSON.stringify({ ...job, status: "complete" })]],
  ["wrong note", job => [JSON.stringify({ ...job, note: null })]],
  ["negative total", job => [JSON.stringify({ ...job, total: -1 })]],
  ["zero total", job => [JSON.stringify({ ...job, total: 0 })]],
  ["oversized total", job => [JSON.stringify({ ...job, total: Number.MAX_SAFE_INTEGER })]],
  ["string total", job => [JSON.stringify({ ...job, total: String(job.total) })]],
  ["missing done", job => [JSON.stringify({ ...job, done: undefined })]],
  ["done past total", job => [JSON.stringify({ ...job, done: job.total + 1 })]],
  ["fraction sent", job => [JSON.stringify({ ...job, sent: 0.5 })]],
  ["sent past done", job => [JSON.stringify({ ...job, sent: job.done + 1 })]],
  ["negative failures", job => [JSON.stringify({ ...job, failures: -1 })]],
  ["missing createdAt", job => [JSON.stringify({ ...job, createdAt: undefined })]],
  ["transport failure", () => { throw new Error("synthetic job read failure"); }],
];
for (const [name, reply] of unreadable) test(`Q boundary ${name} must retain a genuine job for the automatic confirmed retry`, async () => {
  const priorFetch = globalThis.fetch;
  const r = await setup();
  const key = `nl:upd:job:${r.job.id}`;
  const before = await usedThisMonth(r.shop.listId, windowId(r.shop));
  redis.pipeline = async commands => commands.some(c => c[0] === "GET" && c[1] === key) ? reply(r.job) : r.original(commands);
  try {
    await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000).catch(() => null);
    const pending = redis.run(["SISMEMBER", "nl:updq", r.job.id]);
    const payloadRetained = typeof redis.run(["GET", key]) === "string";
    const beforeRetry = r.batches.flat().length;
    const emailAllowanceUsed = await usedThisMonth(r.shop.listId, windowId(r.shop)) - before;
    redis.pipeline = r.original;
    const automaticRetryTouched = await advanceUpdates(storeForHandle, Date.now() + 20000);
    assert.deepEqual({pending,payloadRetained,beforeRetry,emailAllowanceUsed,automaticRetryTouched,afterRetry:r.batches.flat().length}, {
      pending:1,payloadRetained:true,beforeRetry:0,emailAllowanceUsed:0,automaticRetryTouched:1,afterRetry:1,
    });
  } finally { redis.pipeline = r.original; globalThis.fetch = priorFetch; }
});
