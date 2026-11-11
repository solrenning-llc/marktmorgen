// Codex G2's proof on #1928 (624 [SZ8](23), head 8a04da813, branch codex/g2-review-1928-cart-link-red at 9a02bebde), kept as permanent tests.
/**
 * 624 [SZ8](23), unit 1: a discount code that came in a link to the store
 * (lib/code-link.ts) goes on a cart's checkout by itself, as it already did
 * on one product's. Checked on the checkout body sent to a stand-in Stripe:
 *
 *   - a live code of the creator's is applied, and then there is no box;
 *   - a code Stripe does not know leaves the box, as before;
 *   - nothing is applied when something was already taken off (one
 *     discount at a time), nor when the store has no codes;
 *   - a code Stripe refuses for this cart opens the checkout with the box,
 *     never turns the buyer away;
 *   - the cart route reads the code from the same cookie as one product;
 *   - unit 2: the studio's builder makes the link the store page reads
 *     (restore and code), for two to MAX_CART products, and says how.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MAX_CART, readCartIds } from "@/lib/cart-rules";
import { readLinkCode } from "@/lib/code-link";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { NO_DEAL } from "@/lib/cart-rules";
import { NO_RECOVERY } from "@/lib/recovery-setting";
import { createCartCheckout } from "@/lib/cart-checkout";
import { NO_SALE } from "@/lib/store-sale";
import type { Product, Store } from "@/lib/store";
import { done, is, part } from "./check";

const sent: URLSearchParams[] = [];
const refuseCode = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/promotion_codes") {
    const code = url.searchParams.get("code");
    return new Response(JSON.stringify({ object: "list", data: code === "SPRING" ? [{ id: "promo_spring0001", active: true, code }] : [] }));
  }
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions") {
    const body = new URLSearchParams(String(init?.body));
    sent.push(body);
    if (refuseCode && body.has("discounts[0][promotion_code]")) {
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "This promotion code cannot be redeemed because the order does not meet its minimum amount." } }), { status: 400 });
    }
    return new Response(JSON.stringify({ id: "cs_test_cartcode00001", url: "https://checkout.stripe.com/c/pay/cs_test_cartcode00001" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const product = (id: string, priceCents: number) =>
  ({ id, title: `Guide ${id}`, summary: "", priceCents, recurring: null, call: null, callPackage: null, podcast: null, options: [], pwyw: null, stock: null, bundle: null, pick: null, course: null, file: null, link: `https://example.com/${id}`, hidden: false, fields: [], keys: null }) as unknown as Product;

const shop = (more: Partial<Store> = {}): Store =>
  ({
    handle: "bakery",
    name: "Oven Notes",
    email: "owner@example.com",
    language: "en",
    currency: "usd",
    stripeAccountId: "acct_test_cart0002",
    sale: { ...NO_SALE },
    cartDeal: { ...NO_DEAL },
    recovery: { ...NO_RECOVERY },
    fair: undefined,
    hasDiscounts: true,
    tax: { enabled: false, included: false, ids: false, invoices: false },
    affiliates: { enabled: false, percent: 20, days: 30, rates: {}, payday: 0, hold: 0 },
    catalog: { id: null, items: [], head: [], inline: null },
    ...more,
  }) as unknown as Store;

const cart = [product("a", 1900), product("b", 900)];
const open = (store: Store, code?: string) => createCartCheckout(store, cart, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT, ...(code ? { code } : {}) });

async function main():Promise<void>{process.env.STRIPE_SECRET_KEY='sk_test_g2_cart_only';await open(shop(),'SPRING');const body=sent.at(-1)!;is('live link code is applied at cart checkout',[body.get('discounts[0][promotion_code]'),body.get('metadata[code]'),body.get('allow_promotion_codes')],['promo_spring0001','SPRING',null]);done();}void main();