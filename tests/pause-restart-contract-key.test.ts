import { test } from "node:test";
import assert from "node:assert/strict";
import { runBreaks, pauseOf } from "@/lib/plan-pause";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { PLAN_PRICES } from "@/lib/plan";
import { store as redis } from "./redis-stub";

const DAY = 86_400;

async function fixture(handle: string) {
  const email = `${handle}@example.test`, now = Math.floor(Date.now() / 1000);
  await claimHandle(email, handle, "Restart contract fixture", "");
  const subscription = `sub_${handle.replaceAll("-", "")}`;
  await setSubscription(email, { customerId: "cus_RestartContract01", subscriptionId: subscription,
    active: false, tier: "creator", cycle: "month" });
  const store = (await storeForEmail(email))!, ref = storeRef(store);
  const record = { subscription, customer: "cus_RestartContract01", paymentMethod: "pm_RestartContract01",
    tier: "creator", from: now - 31 * DAY, until: now - 1, told: now - 7 * DAY };
  await redis.pipeline([["SET", `nl:pause:${ref}`, JSON.stringify(record)], ["ZADD", "nl:pause:due", record.until, ref]]);
  return { store, ref, record, now, oldKey: `restart:${subscription}:${record.until}` };
}

function provider(f: Awaited<ReturnType<typeof fixture>>, loseFirstAck = false) {
  const original = globalThis.fetch;
  const price = { id: "price_RestartContract01", active: true, currency: "usd",
    unit_amount: PLAN_PRICES.creator.month, lookup_key: "nimbus_labs_creator_month",
    recurring: { interval: "month", interval_count: 1 } };
  const oldBody = new URLSearchParams({ customer: f.record.customer, "items[0][price]": price.id,
    "items[0][quantity]": "1", default_payment_method: f.record.paymentMethod, off_session: "true",
    payment_behavior: "error_if_incomplete", "metadata[store]": f.store.handle,
    "metadata[tier]": "creator", "metadata[restarted]": "break" }).toString();
  const requests: { key: string; body: string; version: string | null }[] = [];
  const ledger = new Map<string, string>([[f.oldKey, oldBody]]);
  let creations = 0, lose = loseFirstAck;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com", "every provider request is intercepted; no external transport");
    if (url.pathname === "/v1/prices") return Response.json({ object: "list", data: [price], has_more: false });
    assert.equal(url.pathname, "/v1/subscriptions"); assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers), key = headers.get("Idempotency-Key")!;
    const body = String(init?.body), version = headers.get("Stripe-Version");
    requests.push({ key, body, version });
    if (ledger.has(key) && ledger.get(key) !== body) {
      return Response.json({ error: { type: "idempotency_error", message: "The key already belongs to the previous request body" } }, { status: 400 });
    }
    if (!ledger.has(key)) { ledger.set(key, body); creations++; }
    if (lose) { lose = false; throw Error("Synthetic lost restart response after provider acceptance"); }
    return Response.json({ id: "sub_RestartContractResult01", status: "active", customer: f.record.customer,
      trial_end: null, metadata: { tier: "creator" }, items: { data: [{ quantity: 1,
        current_period_start: f.now - 10, current_period_end: f.now + 30 * DAY, price }] } });
  };
  return { requests, creations: () => creations, restore: () => { globalThis.fetch = original; } };
}

test("the real pause worker separates the classic body from a previously bound legacy request key", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_plan_pause_only";
  const f = await fixture("restart-contract-first"), p = provider(f);
  try {
    const result = await runBreaks(f.now);
    assert.equal(result.restarted, 1, "the new body must not collide with the earlier request contract");
    assert.equal(p.requests.length, 1); assert.equal(p.creations(), 1);
    assert.notEqual(p.requests[0].key, f.oldKey);
    assert.equal(p.requests[0].key, `${f.oldKey}:classic`);
    assert.equal(new URLSearchParams(p.requests[0].body).get("billing_mode[type]"), "classic");
    assert.equal(p.requests[0].version, "2025-09-30.clover");
    assert.equal(await pauseOf(f.store), null);
  } finally {
    p.restore();
    await redis.pipeline([["DEL", `nl:pause:${f.ref}`], ["ZREM", "nl:pause:due", f.ref]]);
  }
});

test("a lost classic response retries the same key and body without another provider creation", async () => {
  const f = await fixture("restart-contract-retry"), p = provider(f, true);
  try {
    assert.equal((await runBreaks(f.now)).failed, 1);
    assert.ok(await pauseOf(f.store), "unknown acceptance retains the original pause");
    assert.equal((await runBreaks(f.now + 1)).restarted, 1);
    assert.equal(p.requests.length, 2); assert.deepEqual(p.requests[1], p.requests[0]);
    assert.equal(p.requests[0].key, `${f.oldKey}:classic`); assert.equal(p.creations(), 1);
    assert.equal(await pauseOf(f.store), null);
  } finally {
    p.restore();
    await redis.pipeline([["DEL", `nl:pause:${f.ref}`], ["ZREM", "nl:pause:due", f.ref]]);
  }
});
