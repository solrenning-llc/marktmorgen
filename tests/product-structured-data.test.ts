/**
 * What a product page tells search engines (248 [ST1]): an Offer, with its
 * price and availability, only while the page itself lets the product be
 * had: a free product while it can be given (canGiveProduct), a paid one
 * while Stripe (canSellProduct, which needs the store's plan paid up and its
 * Stripe account charging) or the creator's PayPal (paypalReady) takes it.
 * Otherwise the page says it cannot be bought, so the structured data must not
 * say otherwise (VR item 2).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const page = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
const checkout = readFileSync("lib/store-checkout.ts", "utf8");

test("the offer follows what the page lets a visitor do", () => {
  assert.match(page, /productData\(store, product, .*, free \? canGiveProduct\(store, product\) : canSellProduct\(store, product\) \|\| byPayPal\)\} \/>/);
  assert.match(page, /const byPayPal = paypalReady\(store, product\);/);
  assert.match(page, /const offers = !sellable \|\| product\.recurring\s*\?\s*null/);
  // The default is no offer: a caller that forgets the flag tells nothing it cannot keep.
  assert.match(page, /preorder = false, sellable = false\)/);
});

test("selling closed means no paid offer: canSellProduct needs canSell, which needs the plan paid up", () => {
  assert.match(checkout, /if \(!canSell\(store\)\) return false;/);
  assert.match(checkout, /isPaidUp\(store\) &&/);
});
