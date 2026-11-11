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

function provider(f: Awaited<ReturnType<typeof fixture>>, loseFirstAck = false, legacyBound = true) {
  const original = globalThis.fetch;
  const price = { id: "price_RestartContract01", active: true, currency: "usd",
    unit_amount: PLAN_PRICES.creator.month, lookup_key: "nimbus_labs_creator_month",
    recurring: { interval: "month", interval_count: 1 } };
  const oldBody = new URLSearchParams({ customer: f.record.customer, "items[0][price]": price.id,
    "items[0][quantity]": "1", default_payment_method: f.record.paymentMethod, off_session: "true",
    payment_behavior: "error_if_incomplete", "metadata[store]": f.store.handle,
    "metadata[tier]": "creator", "metadata[restarted]": "break" }).toString();
  const requests: { key: string; body: string; version: string | null }[] = [];
  const ledger = new Map<string, string>(legacyBound ? [[f.oldKey, oldBody]] : []);
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
  return { requests, creations: () => creations, expireKey: (key: string) => { ledger.delete(key); }, restore: () => { globalThis.fetch = original; } };
}

test("a prior legacy key binding prevents a second subscription and leaves the pause held", async () => {
  const f = await fixture("restart-contract-legacy-accepted"), p = provider(f);
  try {
    const result = await runBreaks(f.now);
    assert.equal(result.failed, 1, "an idempotency conflict is unknown prior acceptance, not success");
    assert.equal(p.requests.length, 1);
    assert.equal(p.requests[0].key, f.oldKey, "a retry must preserve the legacy key that may own an accepted result");
    assert.notEqual(new URLSearchParams(p.requests[0].body).get("billing_mode[type]"), null);
    assert.equal(p.creations(), 0, "the changed body cannot create a second subscription under a fresh key");
    assert.ok(await pauseOf(f.store), "the exact pause evidence remains for reconciliation");
    assert.equal(redis.run(["ZSCORE", "nl:pause:due", f.ref]), null, "a held attempt is not scheduled for another POST");
    const later = await runBreaks(f.now + 2 * DAY);
    assert.equal(later.restarted, 0);
    assert.equal(p.requests.length, 1, "a held legacy key is never retried");
    assert.ok(await pauseOf(f.store));
  } finally {
    p.restore();
    await redis.pipeline([["DEL", `nl:pause:${f.ref}`], ["ZREM", "nl:pause:due", f.ref]]);
  }
});

test("a lost response is never retried after the provider idempotency window", async () => {
  const f = await fixture("restart-contract-expired-key"), p = provider(f, true, false);
  try {
    assert.equal((await runBreaks(f.now)).failed, 1);
    assert.equal(p.requests.length, 1);
    assert.equal(p.creations(), 1, "the synthetic provider accepted before losing its response");
    assert.ok(await pauseOf(f.store), "unknown acceptance retains the exact pause");
    assert.equal(redis.run(["ZSCORE", "nl:pause:due", f.ref]), null, "the held attempt is removed from due before any later run");
    p.expireKey(p.requests[0].key);
    const later = await runBreaks(f.now + 2 * DAY);
    assert.equal(later.restarted, 0);
    assert.equal(p.requests.length, 1, "expiry cannot turn a retry into a second provider creation");
    assert.equal(p.creations(), 1);
    assert.ok(await pauseOf(f.store));
  } finally {
    p.restore();
    await redis.pipeline([["DEL", `nl:pause:${f.ref}`], ["ZREM", "nl:pause:due", f.ref]]);
  }
});
