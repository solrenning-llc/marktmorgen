/** Additional financial-boundary controls for Claude 4's three findings.
 * Real orchestration/SES transport, synthetic stores and provider replies.
 * MemoryRedis is an ACK adapter; separate native proofs run the actual Lua.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUMP_KEYS } from "@/lib/bundle-rules";
import { readProduct } from "@/lib/catalog";
import { ADMITTED_FIELD } from "@/lib/order-admission";
import { storeOrdersThisMonth } from "@/lib/orders";
import { confirmPurchase, type SessionRecord } from "@/lib/purchase-email";
import { sesBatch, sesConfig, sesReady } from "@/lib/ses";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductBundle, setProductLink,
  setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { orderDataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";

process.env.NIMBUS_DATA_KEY = "SYNTHETIC_ONLY_CONFIRMATION_ORIGIN_KEY_2026";
process.env.RESEND_API_KEY = "re_SYNTHETIC_A3_C4_CONTROLS";
globalThis.fetch = async () => { throw Error("No external service is allowed in this proof"); };

async function shop() {
  redis.clear();
  const owner = "a3-c4-control@example.test";
  await claimHandle(owner, "a3-c4-control", "Original store", "");
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_TestA3C401", true);
  const now = Math.floor(Date.now() / 1000);
  await setSubscription(owner, { customerId: "cus_A3C4", subscriptionId: "sub_A3C4", active: true, tier: "creator",
    period: { start: now - 86400, end: now + 20 * 86400, renews: true } });
  let store = (await storeForEmail(owner))!;
  const refresh = async () => { store = (await storeForEmail(owner))!; };
  const product = async (title: string, linked = true) => {
    const result = await addProduct(owner, title, "Synthetic original product", "25", null);
    assert.ok(result.ok);
    if (linked) assert.ok((await setProductLink(owner, result.product.id, `https://example.test/${result.product.id}`)).ok);
    await refresh();
    return result.product;
  };
  const holdWithSibling = async (items: number) => {
    const folder = await storeFolder(storeRef(store)), hour = Math.floor(Date.now() / 3600000);
    const open = `nl:orders:open:${folder}`, bytes = `${open}:b`;
    redis.run(["HSET", open, String(hour), 2]);
    redis.run(["HSET", bytes, String(hour), orderDataBytes(items) + orderDataBytes(1)]);
    return { hour, open, bytes, remaining: () => [redis.run(["HGET", open, String(hour)]), redis.run(["HGET", bytes, String(hour)])] };
  };
  const session = (id: string, metadata: Record<string, string>): SessionRecord => ({
    id, status: "complete", payment_status: "paid", mode: "payment", created: Math.floor(Date.now() / 1000),
    amount_total: 2500, currency: "usd", metadata: { store: store.handle, ...metadata },
    customer_details: { email: "paid-buyer@example.test" },
  });
  return { owner, get store() { return store; }, refresh, product, holdWithSibling, session };
}

test("purchased bundle roots with overlapping members settle only their original footprint", async () => {
  const f = await shop(), a = await f.product("A"), b = await f.product("B");
  const root = await f.product("Root", false), bump = await f.product("Bump", false);
  for (const product of [root, bump]) assert.ok((await setProductBundle(f.owner, product.id, [a.id, b.id])).ok);
  await f.refresh();
  for (const product of [root, bump]) assert.equal((await readProduct(f.store, product.id))?.bundle?.length, 2);
  const hold = await f.holdWithSibling(4), key = BUMP_KEYS[0];
  const original = f.session("cs_test_A3BundleOverlap00001", { product: root.id, bundle: `${a.id},${b.id}`,
    [key]: bump.id, [`${key}_bundle`]: `${a.id},${b.id}`, [ADMITTED_FIELD]: String(hold.hour) });
  const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(true);
    assert.equal(await confirmPurchase(f.store, original.id as string, original), "sent");
    assert.equal(await storeOrdersThisMonth(f.store), 1);
    assert.deepEqual(hold.remaining(), ["1", String(orderDataBytes(1))], "another checkout's entire hold remains");
    assert.equal(await confirmPurchase(f.store, original.id as string, original), "already");
    assert.equal(await storeOrdersThisMonth(f.store), 1);
    assert.deepEqual(hold.remaining(), ["1", String(orderDataBytes(1))]);
  } finally { mail.restore(); }
});

test("a later catalog bundle edit cannot change an already paid checkout's accounting footprint", async () => {
  const f = await shop(), a = await f.product("A"), b = await f.product("B"), c = await f.product("C");
  const root = await f.product("Original bundle", false);
  assert.ok((await setProductBundle(f.owner, root.id, [a.id, b.id])).ok);
  await f.refresh();
  const hold = await f.holdWithSibling(2);
  const original = f.session("cs_test_A3BundleCatalog00001", { product: root.id, bundle: `${a.id},${b.id}`, [ADMITTED_FIELD]: String(hold.hour) });
  assert.ok((await setProductBundle(f.owner, root.id, [a.id, b.id, c.id])).ok);
  await f.refresh();
  assert.equal((await readProduct(f.store, root.id))?.bundle?.length, 3);
  const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(true);
    await confirmPurchase(f.store, original.id as string, original);
    assert.equal(await storeOrdersThisMonth(f.store), 1);
    assert.deepEqual(hold.remaining(), ["1", String(orderDataBytes(1))]);
  } finally { mail.restore(); }
});

test("a paid preorder is counted once despite a lost email reply and preserves another held checkout", async () => {
  const f = await shop(), product = await f.product("Preorder");
  const hold = await f.holdWithSibling(1);
  const original = f.session("cs_test_A3PreorderLost00001", { product: product.id, preorder: "yes", [ADMITTED_FIELD]: String(hold.hour) });
  const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(true); mail.setSesOutcome("lost");
    await confirmPurchase(f.store, original.id as string, original);
    assert.equal(mail.calls.ses, 1, "the provider POST really preceded the synthetic lost reply");
    assert.equal(mail.calls.resend, 0, "unknown SES acceptance never permits fallback");
    assert.equal(await storeOrdersThisMonth(f.store), 1);
    assert.deepEqual(hold.remaining(), ["1", String(orderDataBytes(1))]);
    await confirmPurchase(f.store, original.id as string, original);
    assert.equal(await storeOrdersThisMonth(f.store), 1);
    assert.deepEqual(hold.remaining(), ["1", String(orderDataBytes(1))]);
  } finally { mail.restore(); }
});

const messages = ["one", "two", "three"].map(name => ({ from: "Store <mail@example.test>", to: `${name}@example.test`, subject: "Original", text: "Original message" }));

test("a denied SES dispatch keeps every original recipient without a provider POST", async () => {
  redis.clear(); const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(true);
    const config = sesConfig(), state = await sesReady(); assert.ok(config && state);
    const result = await sesBatch(config, state, messages, "a3-denied-batch", async () => false);
    assert.equal(mail.calls.ses, 0);
    assert.equal(result.taken.length, 0);
    assert.deepEqual(result.left, messages);
    assert.ok("notPosted" in result && result.notPosted === true);
  } finally { mail.restore(); }
});

test("a batch stopped after one acceptance keeps its exact unposted tail without another wave", async () => {
  redis.clear(); const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(true, { rate: 1 });
    const config = sesConfig(), state = await sesReady(); assert.ok(config && state);
    let guards = 0;
    const result = await sesBatch(config, state, messages, "a3-partial-denied-batch", async () => ++guards === 1);
    assert.equal(mail.calls.ses, 1);
    assert.deepEqual(result.taken, [messages[0]]);
    assert.deepEqual(result.left, messages.slice(1));
    assert.equal(guards, 2);
    assert.ok("notPosted" in result && result.notPosted === true);
  } finally { mail.restore(); }
});

test("an actual recipient-validation refusal remains distinct from a denied dispatch", async () => {
  redis.clear(); const mail = installSesMailFixture();
  try {
    mail.configure(); await mail.setReady(true); mail.setSesOutcome("refused");
    const config = sesConfig(), state = await sesReady(); assert.ok(config && state);
    const result = await sesBatch(config, state, messages.slice(0, 1), "a3-real-message-refusal", async () => true);
    assert.equal(mail.calls.ses, 1);
    assert.equal(result.taken.length, 0);
    assert.deepEqual(result.left, []);
    assert.equal("notPosted" in result, false);
  } finally { mail.restore(); }
});
