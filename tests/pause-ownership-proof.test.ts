import { test } from "node:test";
import assert from "node:assert/strict";
import { pausePlan, pauseOf, undoPause } from "@/lib/plan-pause";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { PLAN_PRICES } from "@/lib/plan";
import { store as redis } from "./redis-stub";

const DAY = 86_400;

async function fixture(suffix: string) {
  process.env.STRIPE_SECRET_KEY = "sk_test_plan_pause_only";
  const email = `pause-owner-${suffix}@example.test`, now = Math.floor(Date.now() / 1000);
  await claimHandle(email, `pause-owner-${suffix}`, "Pause ownership fixture", "");
  await setSubscription(email, { customerId: "cus_SharedPauseOwner01", subscriptionId: "sub_ForeignPauseOwner01",
    active: true, tier: "creator", cycle: "month" });
  const store = (await storeForEmail(email))!, ref = storeRef(store);
  const otherEmail = `pause-other-${suffix}@example.test`;
  await claimHandle(otherEmail, `pause-other-${suffix}`, "Actual other store fixture", "");
  await setSubscription(otherEmail, { customerId: "cus_SharedPauseOwner01", subscriptionId: "sub_ForeignPauseOwner01",
    active: true, tier: "creator", cycle: "month" });
  const other = (await storeForEmail(otherEmail))!;
  const otherId = other.sid ?? other.statsId ?? storeRef(other);
  assert.notEqual(otherId, store.sid ?? store.statsId ?? ref);
  // A customer's identity is not a store's immutable identity: two stores
  // can use the same customer while this subscription belongs to the other.
  const subscription = { id: "sub_ForeignPauseOwner01", status: "active", customer: "cus_SharedPauseOwner01",
    default_payment_method: "pm_ForeignPauseOwner01", cancel_at_period_end: false,
    metadata: { store_id: otherId, store: other.handle },
    start_date: now - 100 * DAY, trial_end: now - 86 * DAY,
    items: { data: [{ quantity: 1, current_period_start: now - 20 * DAY, current_period_end: now + 10 * DAY,
      price: { id: "price_SharedPauseOwner01", active: true, currency: "usd", unit_amount: PLAN_PRICES.creator.month,
        lookup_key: "nimbus_labs_creator_month", recurring: { interval: "month", interval_count: 1 } } }] } };
  const original = globalThis.fetch, mutations: boolean[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com", "no real provider transport");
    assert.equal(url.pathname, `/v1/subscriptions/${subscription.id}`);
    if (init?.method === "POST") {
      const cancel = new URLSearchParams(String(init.body)).get("cancel_at_period_end") === "true";
      mutations.push(cancel); subscription.cancel_at_period_end = cancel;
    } else assert.ok(!init?.method || init.method === "GET");
    return Response.json(subscription);
  };
  return { store, ref, now, subscription, mutations, restore: async () => {
    globalThis.fetch = original;
    await redis.pipeline([["DEL", `nl:pause:${ref}`, `nl:pause:last:${ref}`], ["ZREM", "nl:pause:due", ref]]);
  } };
}

test("a matching customer cannot authorize pausing a subscription marked for another store", async () => {
  const f = await fixture("foreign");
  try {
    await pausePlan(f.store, 1, f.now).catch(() => undefined);
    assert.deepEqual(f.mutations, [], "prove the store's ownership before any cancellation POST");
    assert.equal(await pauseOf(f.store), null, "refusal must not create a pause for someone else's plan");
  } finally { await f.restore(); }
});

test("undo cannot change a different store's subscription or erase the retained pause", async () => {
  const f = await fixture("undo");
  const record = { subscription: f.subscription.id, customer: f.subscription.customer,
    paymentMethod: f.subscription.default_payment_method, tier: "creator", from: f.now + 10 * DAY,
    until: f.now + 40 * DAY, told: 0 };
  try {
    f.subscription.cancel_at_period_end = true;
    await redis.pipeline([["SET", `nl:pause:${f.ref}`, JSON.stringify(record)], ["ZADD", "nl:pause:due", record.until, f.ref]]);
    await undoPause(f.store, f.now).catch(() => undefined);
    assert.deepEqual(f.mutations, [], "the inverse cancellation also needs the same ownership proof");
    assert.deepEqual(await pauseOf(f.store), record, "unknown or foreign ownership retains the original pause");
  } finally { await f.restore(); }
});
