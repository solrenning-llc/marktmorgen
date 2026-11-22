/**
 * A paid legacy checkout whose accounting stays unknown for a reason that never clears (Codex's MEDIUM on #3667;
 * the coordinator's decision 20261122T200113Z-claude-1-coord-4c5c, option (a)): an hour after its creation, and only
 * while Stripe's read shows it paid, it is counted once at its worst case (one order) and the buyer gets the email.
 * One case per permanent unknown Codex X6 named (a durable partial intent, a key of another type, another owner's
 * record, an unreadable amount, the 45-day horizon), and the guarantees around them: nothing before the hour,
 * nothing for an unpaid checkout, never a second count (after an ordinary commit, on a replay, for two runs at once,
 * past the horizon), and the studio's figure is the counted one. Synthetic only: the Redis stub, a store built here,
 * Resend and Stripe stood in.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { confirmPurchase, confirmationKey } from "@/lib/purchase-email";
import { LEGACY_STUCK_AFTER_MS, storeOrdersThisMonth } from "@/lib/orders";
import { storeFolder, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const emails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(String(JSON.parse(String(init?.body)).to));
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const OWNER = "stuck-owner@example.com";
const seenKey = (reference: string) => `nl:orders:seen:${createHash("sha256").update(reference).digest("hex").slice(0, 32)}`;
let serial = 0;

async function shop() {
  redis.clear();
  emails.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_stuck_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle(OWNER, "stuckshop", "Stuck Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestStuck00001", true);
  await setSubscription(OWNER, { customerId: "cus_Stuck00001", subscriptionId: "sub_Stuck00001", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Field Guide", "", "49", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  const store = (await storeForEmail(OWNER))!;
  const folder = await storeFolder(storeRef(store));
  return { store, product: guide.product.id, folder };
}

/** A paid one-time checkout created `ageMs` ago. */
function checkout(product: string, ageMs: number, over: Record<string, unknown> = {}) {
  serial += 1;
  const id = `cs_test_stuck${String(serial).padStart(6, "0")}aaaa`;
  return {
    object: "checkout.session", id, status: "complete", payment_status: "paid", mode: "payment", currency: "usd", amount_total: 4900,
    created: Math.floor((Date.now() - ageMs) / 1000), customer_details: { email: `buyer${serial}@example.com` },
    metadata: { store: "stuckshop", product }, ...over,
  };
}

const twoHours = 2 * 60 * 60 * 1000;
const seenOf = (session: { id: string }) => redis.run(["GET", seenKey(`checkout:${session.id}`)]);

test("the hour is fixed and small", () => {
  assert.equal(LEGACY_STUCK_AFTER_MS, 60 * 60 * 1000);
});

test("a durable partial intent (oci:) holds nothing after the hour: counted once, the email sent", async () => {
  const { store, product } = await shop();
  const session = checkout(product, twoHours);
  redis.run(["SET", seenKey(`checkout:${session.id}`), `oci:${"a".repeat(64)}`]);
  assert.equal(await confirmPurchase(store, session.id, session as never), "sent");
  assert.deepEqual(emails, [`buyer${serial}@example.com`]);
  assert.equal(await storeOrdersThisMonth(store), 1, "counted at its worst case, never less: the partial may not have counted");
  assert.match(String(seenOf(session)), /^ocf:[0-9a-f]{64}$/);
});

test("a counted-order key of another type holds nothing after the hour", async () => {
  const { store, product } = await shop();
  const session = checkout(product, twoHours);
  redis.run(["RPUSH", seenKey(`checkout:${session.id}`), "wrong type"]);
  assert.equal(await confirmPurchase(store, session.id, session as never), "sent");
  assert.equal(await storeOrdersThisMonth(store), 1);
  assert.match(String(seenOf(session)), /^ocf:/);
});

test("another owner's folder record holds nothing after the hour, and is left as it is", async () => {
  const { store, product, folder } = await shop();
  const session = checkout(product, twoHours);
  redis.run(["SET", `nl:store:folder-owner:${folder}`, "someone-else@example.com"]);
  assert.equal(await confirmPurchase(store, session.id, session as never), "sent");
  assert.equal(await storeOrdersThisMonth(store), 1);
  assert.equal(redis.run(["GET", `nl:store:folder-owner:${folder}`]), "someone-else@example.com");
});

test("an unreadable amount: the accounting no longer holds it; rule 24 holds the email until a read shows the amount, counted once", async () => {
  const { store, product } = await shop();
  const session = checkout(product, twoHours);
  const unreadable = { ...session, amount_total: undefined };
  assert.equal(await confirmPurchase(store, session.id, unreadable as never), "failed", "no guessed amount is ever written (CX-123 rule 24)");
  assert.equal(emails.length, 0);
  assert.equal(await storeOrdersThisMonth(store), 1, "the paid order is counted at its worst case");
  assert.equal(redis.run(["GET", confirmationKey(session.id)]), null, "no mark: the next read tries again");
  assert.equal(await confirmPurchase(store, session.id, session as never), "sent", "read with its amount: sent");
  assert.equal(await storeOrdersThisMonth(store), 1, "and not counted again");
});

test("before the hour, a stuck checkout waits for its ordinary retries: nothing counted, nothing sent", async () => {
  const { store, product } = await shop();
  const session = checkout(product, LEGACY_STUCK_AFTER_MS - 60_000);
  redis.run(["SET", seenKey(`checkout:${session.id}`), `oci:${"a".repeat(64)}`]);
  assert.equal(await confirmPurchase(store, session.id, session as never), "failed");
  assert.deepEqual([emails.length, await storeOrdersThisMonth(store), seenOf(session)], [0, 0, `oci:${"a".repeat(64)}`]);
});

test("a checkout Stripe does not show paid is never counted by the way out", async () => {
  const { store, product } = await shop();
  const session = checkout(product, twoHours, { payment_status: "unpaid" });
  redis.run(["SET", seenKey(`checkout:${session.id}`), `oci:${"a".repeat(64)}`]);
  await confirmPurchase(store, session.id, session as never);
  assert.deepEqual([emails.length, await storeOrdersThisMonth(store)], [0, 0]);
});

test("the 45-day horizon: the stuck order was counted and sent in its first day; a reopen past the horizon never counts it again", async () => {
  const { store, product } = await shop();
  const session = checkout(product, twoHours);
  redis.run(["SET", seenKey(`checkout:${session.id}`), `oci:${"a".repeat(64)}`]);
  assert.equal(await confirmPurchase(store, session.id, session as never), "sent");
  assert.equal(await storeOrdersThisMonth(store), 1);
  // Forty-six days on, every mark has expired: the confirmation's (40 days) and the counted order's (45 days).
  const old = { ...session, created: session.created - 46 * 86_400 };
  redis.run(["DEL", confirmationKey(session.id), seenKey(`checkout:${session.id}`)]);
  assert.equal(await confirmPurchase(store, session.id, old as never), "failed", "past the horizon an earlier count cannot be seen, so nothing is counted on a guess");
  assert.deepEqual([emails.length, await storeOrdersThisMonth(store)], [1, 1]);
});

test("never a second count: after an ordinary commit, on a replay, and for two runs at once", async () => {
  const { store, product } = await shop();
  // Ordinary commit, then the email failed: a later read whose receipt differs lands on the way out as already.
  const first = checkout(product, twoHours);
  redis.run(["SET", seenKey(`checkout:${first.id}`), `oc1:${"b".repeat(64)}`]);
  assert.equal(await confirmPurchase(store, first.id, first as never), "sent");
  assert.equal(await storeOrdersThisMonth(store), 0, "a complete ordinary receipt is counted already: never again");
  // A stuck checkout counted by the way out, its email then lost: the next read counts nothing more.
  const second = checkout(product, twoHours);
  redis.run(["SET", seenKey(`checkout:${second.id}`), `oci:${"a".repeat(64)}`]);
  assert.equal(await confirmPurchase(store, second.id, second as never), "sent");
  redis.run(["DEL", confirmationKey(second.id)]);
  assert.equal(await confirmPurchase(store, second.id, second as never), "sent");
  assert.equal(await storeOrdersThisMonth(store), 1, "one count for the stuck checkout across both reads");
  // Two runs at once for one stuck checkout: one count, one email.
  const third = checkout(product, twoHours);
  redis.run(["SET", seenKey(`checkout:${third.id}`), `oci:${"a".repeat(64)}`]);
  const before = emails.length;
  const outcomes = await Promise.all([confirmPurchase(store, third.id, third as never), confirmPurchase(store, third.id, third as never)]);
  assert.deepEqual(outcomes.sort(), ["already", "sent"]);
  assert.equal(emails.length - before, 1, "one email");
  assert.equal(await storeOrdersThisMonth(store), 2, "one more count");
});
