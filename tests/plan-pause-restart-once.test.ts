// A legacy pause restart is a paid subscription creation. The daily worker
// (cron /api/cron/reminders) retries a restart that failed for a reason other
// than the card for up to RETRY_DAYS. Stripe may prune an idempotency key once
// it is at least 24 hours old, so a key alone never protects a retry made a day
// later: a response lost on day one followed by the day-two POST creates a
// second paid subscription, and no platform webhook adopts the first one.
// An unknown creation result must never authorize another creation POST.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBreaks, pauseOf } from "@/lib/plan-pause";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { PLAN_PRICES } from "@/lib/plan";
import { store as redis } from "./redis-stub";

const DAY = 86_400;
/** Stripe documents that keys can be removed once they are at least 24 hours old. */
const KEY_PRUNED_AFTER = DAY;

async function fixture(handle: string) {
  const email = `${handle}@example.test`, now = Math.floor(Date.now() / 1000);
  await claimHandle(email, handle, "Restart once fixture", "");
  const subscription = `sub_${handle.replaceAll("-", "")}`;
  await setSubscription(email, { customerId: "cus_RestartOnce0001", subscriptionId: subscription,
    active: false, tier: "creator", cycle: "month" });
  const store = (await storeForEmail(email))!, ref = storeRef(store);
  const record = { subscription, customer: "cus_RestartOnce0001", paymentMethod: "pm_RestartOnce0001",
    tier: "creator", from: now - 31 * DAY, until: now - 60, told: now - 7 * DAY };
  await redis.pipeline([["SET", `nl:pause:${ref}`, JSON.stringify(record)], ["ZADD", "nl:pause:due", record.until, ref]]);
  return { store, ref, record, now };
}

/**
 * A synthetic Stripe: it creates on every POST whose key it does not hold,
 * forgets a key once it is KEY_PRUNED_AFTER old on its own clock, and can
 * accept a creation while the response never reaches us.
 */
function provider(f: Awaited<ReturnType<typeof fixture>>, lostAcks: number) {
  const original = globalThis.fetch;
  const price = { id: "price_RestartOnce0001", active: true, currency: "usd",
    unit_amount: PLAN_PRICES.creator.month, lookup_key: "nimbus_labs_creator_month",
    recurring: { interval: "month", interval_count: 1 } };
  const ledger = new Map<string, { body: string; at: number; id: string }>();
  const created: string[] = [];
  const clock = { now: f.now };
  let posts = 0, lose = lostAcks;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com", "every provider request is intercepted; no external transport");
    if (url.pathname === "/v1/prices") return Response.json({ object: "list", data: [price], has_more: false });
    // A positive read of the customer's subscriptions sees every creation.
    if (url.pathname === "/v1/subscriptions" && (init?.method ?? "GET") === "GET") {
      return Response.json({ object: "list", has_more: false, data: created.map((id) => subscriptionObject(id)) });
    }
    if (url.pathname.startsWith("/v1/subscriptions/") && (init?.method ?? "GET") === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/v1/subscriptions/".length));
      if (!created.includes(id)) return Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 });
      return Response.json(subscriptionObject(id));
    }
    if (url.pathname === "/v1/subscriptions/search") {
      return Response.json({ object: "search_result", has_more: false, data: created.map((id) => subscriptionObject(id)) });
    }
    assert.equal(url.pathname, "/v1/subscriptions"); assert.equal(init?.method, "POST");
    posts++;
    const key = new Headers(init?.headers).get("Idempotency-Key")!, body = String(init?.body);
    const held = ledger.get(key);
    if (held && clock.now - held.at >= KEY_PRUNED_AFTER) ledger.delete(key);
    let entry = ledger.get(key);
    if (entry && entry.body !== body) {
      return Response.json({ error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters" } }, { status: 400 });
    }
    if (!entry) {
      entry = { body, at: clock.now, id: `sub_RestartOnceNew${String(created.length + 1).padStart(2, "0")}` };
      ledger.set(key, entry);
      created.push(entry.id);
    }
    if (lose > 0) { lose--; throw Error("Synthetic lost restart response after provider acceptance"); }
    return Response.json(subscriptionObject(entry.id));
  };
  function subscriptionObject(id: string) {
    return { id, object: "subscription", status: "active", customer: f.record.customer, trial_end: null,
      cancel_at_period_end: false, metadata: { store: f.store.handle, tier: "creator", restarted: "break" },
      // The worker reads periods against the real clock; keep them current there.
      items: { data: [{ quantity: 1, current_period_start: Math.floor(Date.now() / 1000) - 10,
        current_period_end: Math.floor(Date.now() / 1000) + 30 * DAY, price }] } };
  }
  return { clock, created, posts: () => posts, restore: () => { globalThis.fetch = original; } };
}

async function cleanup(ref: string) {
  await redis.pipeline([["DEL", `nl:pause:${ref}`], ["ZREM", "nl:pause:due", ref]]);
}

test("a restart whose response was lost is never created again after Stripe may prune its key", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_plan_pause_only";
  const f = await fixture("restart-once-lost"), p = provider(f, 1);
  try {
    const first = await runBreaks(f.now);
    assert.equal(first.restarted, 0, "a lost response is not a confirmed restart");
    assert.equal(p.created.length, 1, "the provider accepted the first creation");
    assert.ok(await pauseOf(f.store), "an unknown creation result keeps the pause as evidence");

    // The next daily passes run after the key may be gone, still inside RETRY_DAYS.
    for (const later of [DAY + 3_600, 2 * DAY + 3_600]) {
      p.clock.now = f.now + later;
      await runBreaks(f.now + later);
      assert.equal(p.created.length, 1, `no second paid subscription ${later}s after the lost response`);
      assert.equal(p.posts(), 1, `no second creation POST while the first result is unknown (${later}s later)`);
    }
  } finally {
    p.restore();
    await cleanup(f.ref);
  }
});

test("the retry window ending after a lost response never creates a second paid subscription", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_plan_pause_only";
  const f = await fixture("restart-once-window"), p = provider(f, 1);
  try {
    await runBreaks(f.now);
    for (const later of [DAY + 60, 2 * DAY + 60, 3 * DAY + 60, 4 * DAY + 60]) {
      p.clock.now = f.now + later;
      await runBreaks(f.now + later);
    }
    assert.equal(p.created.length, 1, "exactly one paid subscription across the whole retry window");
    assert.equal(p.posts(), 1, "one creation POST across the whole retry window");
  } finally {
    p.restore();
    await cleanup(f.ref);
  }
});

test("a confirmed restart still creates exactly once (control)", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_plan_pause_only";
  const f = await fixture("restart-once-control"), p = provider(f, 0);
  try {
    const result = await runBreaks(f.now);
    assert.equal(result.restarted, 1);
    assert.equal(p.created.length, 1);
    assert.equal(p.posts(), 1);
    assert.equal(await pauseOf(f.store), null, "a confirmed restart ends the pause");
  } finally {
    p.restore();
    await cleanup(f.ref);
  }
});
