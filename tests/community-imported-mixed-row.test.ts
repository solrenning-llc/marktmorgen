/**
 * Claude 6's LEVE 1 on #2794 (7057905304): a door that takes something away on a no (holdsProductsOrThrow, the same
 * reading as a strict community door) never reads an imported record that does not read as "not brought over".
 * One product's record legible, the other's not: the legible one is still held, the other is unknown (a throw),
 * never false. Synthetic: the tests' in-memory Redis, a stubbed Stripe with no payments.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addProduct, claimHandle, ensureStatsId, setPastBuyers, setProductLink, setStripeAccount, storeForEmail } from "@/lib/store";
import { importedKey } from "@/lib/imported-purchases";
import { holdsProductsOrThrow } from "@/lib/community-access";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_community_imported_mixed_row";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const JOB = "0123456789abcdef01234567";
const EMAIL = "zed@example.com";

test("an unreadable brought-over record is unknown to a strict door, and a legible one still holds", async () => {
  redis.clear();
  const OWNER = "community-mixed@example.com";
  await claimHandle(OWNER, "mixedclub", "Mixed Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMixedClub1", true);
  const a = await addProduct(OWNER, "Guide A", "", "12", null);
  const b = await addProduct(OWNER, "Guide B", "", "12", null);
  if (!a.ok || !b.ok) throw new Error("no product");
  await setProductLink(OWNER, a.product.id, "https://example.com/a");
  await setProductLink(OWNER, b.product.id, "https://example.com/b");
  await setPastBuyers(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const at = Math.floor(Date.now() / 1000) - 86_400;
  await redis.pipeline([["HSET", importedKey(store.statsId!, EMAIL), a.product.id, JSON.stringify({ at, job: JOB }), b.product.id, JSON.stringify({ at, job: JOB, option: "not a valid option" })]]);

  await assert.rejects(holdsProductsOrThrow(store, [b.product.id], EMAIL, "nl:test:mixed:b", "v1"), "Guide B's record does not read: unknown, never a no");
  assert.equal(await holdsProductsOrThrow(store, [a.product.id], EMAIL, "nl:test:mixed:a", "v1"), true, "Guide A's legible record still holds");
  assert.equal(await holdsProductsOrThrow(store, [a.product.id, b.product.id], EMAIL, "nl:test:mixed:ab", "v1"), true, "either one: the legible one is enough");
});
