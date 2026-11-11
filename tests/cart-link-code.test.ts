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
import { CartLinkBuilder, cartLink } from "@/components/cart-link-builder";
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
let refuseCode = false;
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

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("A code from a link");
  await open(shop(), "SPRING");
  let body = sent.at(-1)!;
  is("a live code of the creator's is applied, with no box beside it", [body.get("discounts[0][promotion_code]"), body.get("metadata[code]"), body.get("allow_promotion_codes")], ["promo_spring0001", "SPRING", null]);
  await open(shop(), "NOSUCH");
  body = sent.at(-1)!;
  is("one Stripe does not know leaves the box, as before", [body.get("discounts[0][promotion_code]"), body.get("allow_promotion_codes")], [null, "true"]);
  await open(shop());
  is("no code: the box, as before", sent.at(-1)!.get("allow_promotion_codes"), "true");

  part("One discount at a time");
  const now = Math.floor(Date.now() / 1000);
  await open(shop({ sale: { ...NO_SALE, percent: 20, starts: now - 60, ends: now + 3600, all: true, products: [], coupon: "c" } }), "SPRING");
  body = sent.at(-1)!;
  is("a sale already taken off: no code and no box", [body.get("discounts[0][promotion_code]"), body.get("allow_promotion_codes")], [null, null]);
  await open(shop({ hasDiscounts: false }), "SPRING");
  is("a store with no codes: nothing applied", sent.at(-1)!.get("discounts[0][promotion_code]"), null);

  part("Refused for this cart");
  refuseCode = true;
  const before = sent.length;
  const opened = await open(shop(), "SPRING");
  const [first, second] = sent.slice(before);
  is("tried with the code, then opened with the box instead", [first.get("discounts[0][promotion_code]"), second.get("discounts[0][promotion_code]"), second.get("metadata[code]"), second.get("allow_promotion_codes"), typeof opened.url], ["promo_spring0001", null, null, "true", "string"]);
  refuseCode = false;

  part("The route");
  const route = readFileSync("app/api/store/cart/route.ts", "utf8");
  is("the cart reads the code from the same cookie as one product", route.includes("code: readLinkCode(request.cookies.get(codeCookieName(store.handle))?.value) || undefined"), true);

  part("The studio's link builder");
  const base = "https://marktmorgen.com/@bakery";
  const made = cartLink(base, ["aaaaaa", "bbbbbb"], " spring ");
  is("two products and a code", made, `${base}?restore=aaaaaa,bbbbbb&code=SPRING`);
  const url = new URL(made);
  is("read back as the store page and the checkout read them", [readCartIds((url.searchParams.get("restore") ?? "").split(",")), readLinkCode(url.searchParams.get("code"))], [["aaaaaa", "bbbbbb"], "SPRING"]);
  is("no code is fine", cartLink(base, ["aaaaaa", "bbbbbb"], ""), `${base}?restore=aaaaaa,bbbbbb`);
  is("one product, more than a cart holds, or a code of the wrong shape: no link", [cartLink(base, ["aaaaaa"], ""), cartLink(base, ["a1", "a2", "a3", "a4", "a5"].slice(0, MAX_CART + 1), ""), cartLink(base, ["aaaaaa", "bbbbbb"], "no spaces!")], ["", "", ""]);
  const drawn = renderToStaticMarkup(createElement(CartLinkBuilder, { address: base, products: [{ id: "aaaaaa", title: "Bread" }, { id: "bbbbbb", title: "Pastry" }] }));
  is("a named section, a list of products with a legend, a labeled code field with its help", [drawn.includes('aria-labelledby="cart-link-title"'), drawn.includes("<legend"), drawn.includes('for="cart-link-code"'), drawn.includes('aria-describedby="cart-link-code-help"')], [true, true, true, true]);
  is("it says what to do before the link exists, in a live region", drawn.includes('aria-live="polite"') && drawn.includes("Choose at least two products to make the link."), true);
  is("nothing with fewer than two products to choose", renderToStaticMarkup(createElement(CartLinkBuilder, { address: base, products: [{ id: "aaaaaa", title: "Bread" }] })), "");
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  // A part of its own (#2900), whose count the next store write waits for (tests/studio-today-removal-order.test.ts).
  is(
    "shown in the studio where a cart is offered, from the products a cart takes",
    [
      "{offersCart(store) ? (async () => {",
      "const products = cartLinkProducts(store);",
      "serverWrite.done = products;",
      "return <CartLinkBuilder address={`${SITE_URL}/@${store.handle}`} products={await products} more={cartLinkCandidates(store).length > CART_LINK_CHOICES ? CART_LINK_CHOICES : 0} />;",
    ].every((line) => studio.includes(line)),
    true,
  );
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
