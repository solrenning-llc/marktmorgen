/**
 * Issue #4400 (erasure, Codex X4; fix by Codex L, applied by Claude 2 cloud C): the studio's buyers page said
 * "That person was deleted from your store" for anyone who opened /studio/people?erased=1, with no erasure, and
 * &discord=1 invented the Discord warning. Now the page says it only on a receipt the server signed after the
 * erasure succeeded, bound to the store and valid for ten minutes, with the Discord bit inside it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makePersonErasureReceipt, readPersonErasureReceipt } from "@/lib/erasure-receipt";

process.env.NIMBUS_DATA_KEY = "synthetic-person-erasure-key-0123456789abcdef";
const now = 1_800_000_000_000;

test("only a recent server receipt for this store proves a person's erasure", () => {
  const receipt = makePersonErasureReceipt("sid_store_a", true, now);
  assert.notEqual(receipt, "");
  assert.deepEqual(readPersonErasureReceipt(receipt, "sid_store_a", now + 1), { discord: true });
  assert.deepEqual(readPersonErasureReceipt(makePersonErasureReceipt("sid_store_a", false, now), "sid_store_a", now + 1), { discord: false });
  assert.equal(readPersonErasureReceipt("1", "sid_store_a", now + 1), null);
  assert.equal(readPersonErasureReceipt(receipt, "sid_store_b", now + 1), null);
  assert.equal(readPersonErasureReceipt(receipt.slice(0, -1) + (receipt.endsWith("A") ? "B" : "A"), "sid_store_a", now + 1), null);
  assert.equal(readPersonErasureReceipt(receipt, "sid_store_a", now - 1), null);
  assert.equal(readPersonErasureReceipt(receipt, "sid_store_a", now + 600_000), null);
});

test("the page and the route use the receipt, never a bare ?erased=1 or &discord=1", () => {
  const page = readFileSync("app/studio/people/page.tsx", "utf8");
  const route = readFileSync("app/api/store/person/route.ts", "utf8");
  assert.equal(page.includes('query.erased === "1"'), false);
  assert.equal(page.includes('query.discord === "1"'), false);
  assert.equal(page.includes("readPersonErasureReceipt(query.erased"), true);
  assert.equal(route.includes("&discord=1"), false);
  assert.equal(route.includes("makePersonErasureReceipt("), true);
});
