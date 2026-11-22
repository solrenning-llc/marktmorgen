/**
 * The memberships' cache (nl:mnum, lib/membership-numbers.ts) is written only while its store is live (sibling of
 * Codex L-20261119-2235): a refresh begun while the store was live and written after its erasure began or ended
 * would bring the family back after the closing walk passed it, naming what members wrote when leaving.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { membershipNumbers } from "@/lib/membership-numbers";
import { ERASING_KEY, addProduct, claimHandle, ensureListId, ensureStatsId, erasingField, ownerKey, setStripeAccount, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];
let subs: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "api.stripe.com", "synthetic Stripe requests only");
  return new Response(JSON.stringify({ object: "list", data: url.pathname === "/v1/subscriptions" ? subs : [], has_more: false }));
}) as typeof fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_members_cache_store_erasure_only";

async function seed(leaving: boolean): Promise<Store> {
  redis.clear();
  const owner = "owner@example.test";
  assert.equal((await claimHandle(owner, "synthetic", "Synthetic", "")).ok, true);
  await ensureStatsId(owner); await ensureListId(owner); await setStripeAccount(owner, "acct_1TestHarbor0002", true);
  const made = await addProduct(owner, "Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  assert.equal(made.ok, true); if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const now = Math.floor(Date.now() / 1000);
  subs = ["member@example.test", "other@example.test"].map((email, i) => ({
    id: `sub_Race00000${i}`, object: "subscription", status: leaving ? "canceled" : "active", currency: "usd", start_date: now - 90 * 86400,
    ...(leaving ? { ended_at: now - 1_000, canceled_at: now - 1_000, cancellation_details: { reason: "cancellation_requested", feedback: "too_expensive", comment: `${email} wrote a synthetic note` } } : {}),
    customer: { id: `cus_Race00000${i}`, object: "customer", email }, metadata: { store: store.handle, product: made.product.id },
    items: { data: [{ quantity: 1, current_period_end: now + 86400, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
  }));
  return store;
}

async function erase(store: Store, how: "gone" | "erasing", run: (c: Command[]) => Promise<unknown>) {
  if (how === "erasing") await run([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]);
  else await run([["DEL", storeIdCommand(store.sid)[1]], ["DEL", await ownerKey(storeRef(store))]]);
}

/** Runs `work` with the store erased just before the first write that names `key`. */
async function erasedBeforeWrite(store: Store, key: string, how: "gone" | "erasing", work: () => Promise<unknown>): Promise<boolean> {
  const original = redis.pipeline.bind(redis);
  let raced = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!raced && commands.some((c) => (c[0] === "SET" && c[1] === key) || (c[0] === "EVAL" && c.slice(2).includes(key)))) {
      raced = true;
      await erase(store, how, original as (c: Command[]) => Promise<unknown>);
    }
    return original(commands);
  }) as typeof redis.pipeline;
  try { await work(); } finally { redis.pipeline = original; }
  return raced;
}

for (const how of ["gone", "erasing"] as const) {
  for (const leaving of [false, true]) {
    test(`the memberships' cache (${leaving ? "naming what members wrote" : "naming nobody"}) is not written back after the store is ${how}`, async () => {
      const store = await seed(leaving); const key = `nl:mnum:${store.statsId}`;
      assert.equal(await erasedBeforeWrite(store, key, how, () => membershipNumbers(store, true)), true, "the store was erased before the write");
      assert.equal(redis.run(["GET", key]), null);
    });
  }
}

for (const leaving of [false, true]) {
  test(`control: a live store keeps the memberships' cache (${leaving ? "naming what members wrote" : "naming nobody"})`, async () => {
    const store = await seed(leaving);
    await membershipNumbers(store, true);
    assert.equal(typeof redis.run(["GET", `nl:mnum:${store.statsId}`]), "string");
  });
}
