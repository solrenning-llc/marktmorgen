/**
 * A product past the store's first page is read from its own record, and only in its exact shape (CX-123 rule 24;
 * Claude 4, after Claude 5's proof tests/f-paypal-listing-unknown.test.ts on claude5/f-buyer-profile-listing):
 *
 *   - readListings / readListing: a reply cut short, of another shape, a record that is not JSON, not a listing, or
 *     another product's throws UnknownReplyError, never "the store has no such product"; only a GET nil is none;
 *   - handOverPayPal: everything it hands over is read before anything is, so a bundle's item that does not read
 *     throws before the buyer is given part of it, and the order is kept to be handed over by the sweep.
 *
 * Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addProduct, claimHandle, ensureStatsId, setProductBundle, setProductLink, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing, readListings, STORE_PAGE_SIZE } from "@/lib/catalog";
import { handOverPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "catalog-exact@example.com";
type Batch = (string | number)[][];

const fixture = (async () => {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_catalog_read_exact";
  await claimHandle(OWNER, "catalogexact", "Catalog Exact", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_CatExact001", subscriptionId: "sub_CatExact001", active: true, period: paidPeriod() });
  for (let i = 0; i < STORE_PAGE_SIZE; i += 1) {
    const more = await addProduct(OWNER, `Synthetic ${i}`, "", "9", null);
    if (!more.ok) throw new Error(`no product ${i}`);
  }
  const ids: string[] = [];
  for (const title of ["Far guide", "Far course notes", "Far bundle"]) {
    const added = await addProduct(OWNER, title, "", "19", null);
    if (!added.ok) throw new Error(`no ${title}`);
    ids.push(added.product.id);
    if (title !== "Far bundle") await setProductLink(OWNER, added.product.id, `https://example.com/${ids.length}`);
  }
  const [guide, notes, bundle] = ids;
  const bundled = await setProductBundle(OWNER, bundle, [guide, notes]);
  assert.equal(bundled.ok, true, JSON.stringify(bundled));
  const store = (await storeForEmail(OWNER)) as Store;
  assert.equal(store.catalog.head.some((l) => ids.includes(l.id)), false, "the three are past the first page");
  const key = (id: string) => `nl:catalog:${store.catalog.id}:l:${id}`;
  return { store, guide, notes, bundle, key };
})();

async function withReplies<T>(alter: (batch: Batch, answers: unknown[]) => unknown[], run: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => alter(batch, await original(batch))) as typeof redis.pipeline;
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  } finally {
    redis.pipeline = original;
  }
}
async function withRecord<T>(key: string, raw: string, run: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const [kept] = await redis.pipeline([["GET", key]]);
  redis.run(["SET", key, raw]);
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  } finally {
    redis.run(["SET", key, String(kept)]);
  }
}
const listingGets = (batch: Batch) => batch.length > 0 && batch.every((c) => c[0] === "GET" && String(c[1]).includes(":l:"));

test("a listing past the first page reads, in the order asked", async () => {
  const { store, guide, notes } = await fixture;
  assert.equal((await readListing(store, guide))?.id, guide);
  assert.deepEqual((await readListings(store, [notes, guide])).map((l) => l.id), [notes, guide]);
});

test("a listing whose record is confirmed gone (GET nil) is no such product", async () => {
  const { store, guide, notes, key } = await fixture;
  const result = await withReplies((batch, answers) => (listingGets(batch) ? batch.map((c, i) => (c[1] === key(guide) ? null : answers[i])) : answers), async () => ({
    one: await readListing(store, guide),
    many: (await readListings(store, [guide, notes])).map((l) => l.id),
  }));
  assert.deepEqual(result.value, { one: null, many: [notes] });
});

for (const [label, alter] of [
  ["no replies", () => []],
  ["one reply short", (a: unknown[]) => a.slice(0, -1)],
  ["a reply too many", (a: unknown[]) => [...a, null]],
  ["a number where a record was", (a: unknown[]) => a.map(() => 7)],
  ["each reply wrapped in an object", (a: unknown[]) => a.map((r) => ({ result: r }))],
] as [string, (a: unknown[]) => unknown[]][]) {
  test(`readListings: ${label} throws, never "no such product"`, async () => {
    const { store, guide, notes } = await fixture;
    const one = await withReplies((b, a) => (listingGets(b) ? alter(a) : a), () => readListing(store, guide));
    assert.ok(one.error, `readListing rejected, not ${JSON.stringify(one.value)}`);
    const many = await withReplies((b, a) => (listingGets(b) ? alter(a) : a), () => readListings(store, [guide, notes]));
    assert.ok(many.error, `readListings rejected, not ${JSON.stringify(many.value)}`);
  });
}

for (const [label, raw] of [
  ["not JSON", "{\"id\": not json"],
  ["JSON that is not a listing", "[1,2]"],
] as [string, string][]) {
  test(`readListings: a stored record that is ${label} throws, never left out`, async () => {
    const { store, guide, notes, key } = await fixture;
    const result = await withRecord(key(guide), raw, () => readListings(store, [guide, notes]));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  });
}

test("readListings: another product's record under this one's key throws", async () => {
  const { store, guide, notes, key } = await fixture;
  const [other] = await redis.pipeline([["GET", key(notes)]]);
  const result = await withRecord(key(guide), String(other), () => readListing(store, guide));
  assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
});

test("handOverPayPal: a bundle's item that does not read hands nothing over, and throws", async () => {
  const { store, bundle, notes, key } = await fixture;
  const paid = { store: store.statsId!, order: "5O190127TN3647188", capture: "3C679366HH908788", email: "bundle-buyer@example.com", product: bundle, cents: 1900, currency: "usd", at: Math.floor(Date.now() / 1000), handle: store.handle };
  const result = await withRecord(key(notes), "not json", () => handOverPayPal(store, paid));
  assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  assert.equal((await importedFor((await storeForEmail(OWNER))!, paid.email)).length, 0, "nothing handed over in part");
});
