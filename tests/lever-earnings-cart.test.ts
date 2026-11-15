import assert from "node:assert/strict";
import test from "node:test";
import { leverEarnedWords, leverEarnings, type LeverReading, type LeverKey } from "@/lib/lever-earnings";

// #4736 and #4737 (Codex X8): a cart (lib/cart-checkout.ts, metadata cart=yes) writes the products after its first
// under the same bump/bump2/bump3 keys an order bump uses, and a bundle in it under bundle, bump_bundle, bump2_bundle
// or bump3_bundle by its position. On "Grow your sales" a cart's extra products are never order bump money, and a
// cart that holds a bundle, in any position, is one order counted for Bundle without an amount: its total also pays
// for its other products and the record does not split it. A bundle sold in its own checkout keeps its rule.
// Synthetic records only; no provider is called.

const now = Date.parse("2026-11-10T12:00:00Z");
const created = Math.floor((now - 3_600_000) / 1000);
function checkout(meta: Record<string, string>, cents: number, off = 0) {
  const row: Record<string, unknown> = { object: "checkout.session", status: "complete", payment_status: "paid", amount_total: cents, currency: "usd", created, metadata: meta, total_details: { amount_discount: off, amount_tax: 0 } };
  return { created: created * 1000, cents, currency: "usd", upsell: false, row };
}
const measured = (row: LeverReading["rows"][LeverKey] | undefined) => {
  assert.ok(row && "measured" in row && row.measured, "measured lever");
  return row;
};

test("#4736: a cart's extra products are never counted as order bump money", () => {
  const cart = checkout({ product: "main0001", cart: "yes", bump: "extra001", bump_cents: "1500", bump2: "extra002", bump2_cents: "700" }, 5200);
  const discounted = checkout({ product: "main0001", cart: "yes", bump: "extra001", bump_cents: "1500" }, 4000, 500);
  const realBump = checkout({ product: "main0001", bump: "extra001", bump_cents: "1500" }, 4500);
  const bump = measured(leverEarnings([cart, discounted, realBump], "usd", false, now).rows.bump);
  assert.deepEqual(bump.amounts, [{ currency: "usd", cents: 1500, orders: 1 }], "only the checkout that is not a cart");
  assert.equal(bump.left, 0, "a discounted cart is not an order bump left out either");
});

test("#4737: the same cart holding a bundle has the same Bundle evidence in any position", () => {
  const positions: Record<string, string>[] = [
    { product: "bndl0001", cart: "yes", bundle: "item0001,item0002", bump: "extra001", bump_cents: "3200" },
    { product: "extra001", cart: "yes", bump: "bndl0001", bump_cents: "2400", bump_bundle: "item0001,item0002" },
    { product: "extra001", cart: "yes", bump: "extra002", bump_cents: "800", bump2: "bndl0001", bump2_cents: "2400", bump2_bundle: "item0001,item0002" },
    { product: "extra001", cart: "yes", bump: "extra002", bump_cents: "800", bump2: "extra003", bump2_cents: "100", bump3: "bndl0001", bump3_cents: "2400", bump3_bundle: "item0001,item0002" },
  ];
  for (const [at, meta] of positions.entries()) {
    const bundle = measured(leverEarnings([checkout(meta, 5600)], "usd", false, now).rows.bundle);
    assert.deepEqual([bundle.amounts, bundle.left], [[{ currency: "usd", cents: 0, orders: 0 }], 1], `position ${at + 1}: one order, no amount`);
  }
  const twoBundles = measured(leverEarnings([checkout({ product: "bndl0001", cart: "yes", bundle: "item0001,item0002", bump: "bndl0002", bump_cents: "2400", bump_bundle: "item0003,item0004" }, 5600)], "usd", false, now).rows.bundle);
  assert.equal(twoBundles.left, 1, "a cart with two bundles is still one order");
});

test("#4737: a bundle sold in its own checkout keeps its rule, and the card says how a cart is counted", () => {
  const own = measured(leverEarnings([checkout({ product: "bndl0001", bundle: "item0001,item0002" }, 2400)], "usd", false, now).rows.bundle);
  assert.deepEqual([own.amounts, own.left], [[{ currency: "usd", cents: 2400, orders: 1 }], 0]);
  const words = leverEarnedWords(own, "bundle", true);
  assert.match(words.how, /cart/i, "the explanation names carts");
  assert.match(leverEarnedWords(own, "bump", true).how, /cart/i, "the order bump explanation says a cart's products are not bumps");
});
