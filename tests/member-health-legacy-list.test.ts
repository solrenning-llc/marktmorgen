/**
 * A store snapshot with no list id (a store from before lists, or one read before an erasure gave it one) still gets
 * its members' health (Claude 3's and Claude 2's LOW on #4914): the list is looked up fresh (listForNaming, at most
 * once a UTC day for a store that truly has none) and the copy is kept only through it; a person the store deleted
 * meanwhile never comes back. Synthetic Stripe only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memberHealth } from "@/lib/member-health";
import { suppressCommand } from "@/lib/suppression";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const ERASED = "erased@example.test";
const KEPT = "kept@example.test";
let subs: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, "api.stripe.com", "synthetic Stripe requests only");
  return new Response(JSON.stringify({ object: "list", data: url.pathname === "/v1/subscriptions" ? subs : [], has_more: false }));
}) as typeof fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_member_health_legacy_list_only";

async function seed(): Promise<Store> {
  redis.clear();
  const owner = "owner@example.test";
  assert.equal((await claimHandle(owner, "legacy", "Legacy", "")).ok, true);
  await ensureStatsId(owner); await ensureListId(owner); await setStripeAccount(owner, "acct_1TestHarbor0003", true);
  const made = await addProduct(owner, "Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  assert.equal(made.ok, true); if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const now = Math.floor(Date.now() / 1000);
  subs = [ERASED, KEPT].map((email, i) => ({
    id: `sub_Legacy0000${i}`, status: "active", currency: "usd", start_date: now - 90 * 86400,
    customer: { id: `cus_Legacy0000${i}`, email }, metadata: { store: store.handle, product: made.product.id },
    items: { data: [{ quantity: 1, current_period_end: now + 86400, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
  }));
  return store;
}

test("a snapshot with no list id still answers its members, through the store's list read fresh", async () => {
  const store = await seed();
  const health = await memberHealth({ ...store, listId: null }, true);
  assert.notEqual(health, null, "the members' health is answered");
  assert.deepEqual(health!.members.map((m) => m.email).sort(), [ERASED, KEPT].sort());
});

test("a person the store deleted before is never answered, though the snapshot had no list id", async () => {
  const store = await seed();
  await redis.pipeline([suppressCommand(store.listId!, ERASED)]);
  const health = await memberHealth({ ...store, listId: null }, true);
  assert.notEqual(health, null);
  assert.deepEqual(health!.members.map((m) => m.email), [KEPT]);
  const kept = redis.run(["GET", `nl:health:${store.statsId}`]);
  assert.equal(typeof kept === "string" && kept.includes(ERASED), false, "nor kept");
});
