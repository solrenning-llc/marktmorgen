/**
 * Physical products in the cart (513 [PF1], unit 2b; lib/cart-rules.ts,
 * lib/cart-checkout.ts, lib/cart-shipping.ts, app/api/store/cart; added 2
 * November 2026). Checked, with Stripe mocked:
 *
 *   - a product the creator ships goes in a cart, at one price and not
 *     limited; a limited one or one with sizes does not, yet;
 *   - the checkout asks Stripe for an address only in the countries they
 *     all ship to, adds each one's shipping on one line, says when it ships
 *     only when that is one line, marks the order as shipped, and with
 *     Stripe Tax on (added or included) taxes the shipping as shipping and
 *     each shipped line as goods; the deal for buying more never touches
 *     the shipping;
 *   - a cart whose products share no country, or that mixes shipped
 *     products with ones handed over online, opens nothing, and the route
 *     sends the buyer back to the cart;
 *   - a cart of shipped products only needs no box to start at once;
 *   - the open cart says, before paying, what each product's shipping is,
 *     what shipping comes to and where it can go, the visitor's country when
 *     it is not one of them, and which products to take out, with the total
 *     what Stripe will charge before tax and the deal's saving without the
 *     shipping;
 *   - the thanks page says a second shipped product goes to the same address.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { cartable } from "@/lib/cart-rules";
import { CartShippingRefused, createCartCheckout } from "@/lib/cart-checkout";
import { sharedShipNote, shippedFirst, shipsWithOnline } from "@/lib/cart-shipping";
import { NO_DEAL } from "@/lib/cart-rules";
import { NO_RECOVERY } from "@/lib/recovery-setting";
import { NO_SALE } from "@/lib/store-sale";
import { addProduct, claimHandle, ensureStatsId, setCartDeal, setProductLink, setProductShipping, setStripeAccount, setSubscription } from "@/lib/store";
import { GET as readCart, POST as payCart } from "@/app/api/store/cart/route";
import type { Product, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const sent: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    sent.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: "cs_test_cart0000000002", url: "https://checkout.stripe.com/c/pay/cs_test_cart0000000002" }));
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ship = (countries: string[], cents: number, note = "") => ({ cents, region: "custom", countries, note });
const product = (id: string, more: Partial<Product> = {}) =>
  ({ id, title: `Item ${id}`, summary: "", priceCents: 2000, recurring: null, call: null, callPackage: null, podcast: null, options: [], pwyw: null, plan: null, stock: null, bundle: null, pick: null, course: null, file: null, link: `https://example.com/${id}`, hidden: false, fields: [], keys: null, shipping: null, ...more }) as unknown as Product;
const physical = (id: string, countries: string[], cents: number, note = "") => product(id, { link: null, shipping: ship(countries, cents, note) as never });

function shop(more: Partial<Store> = {}): Store {
  return {
    handle: "makers",
    name: "Paper Makers",
    email: "owner@example.com",
    language: "en",
    currency: "usd",
    stripeAccountId: "acct_test_cart0002",
    sale: { ...NO_SALE },
    cartDeal: { ...NO_DEAL },
    recovery: { ...NO_RECOVERY },
    fair: undefined,
    hasDiscounts: false,
    tax: { enabled: false, included: false, ids: false, invoices: false },
    affiliates: { enabled: false, percent: 0, days: 30, rates: {}, payday: 0, hold: 0 },
    catalog: { id: null, items: [], head: [], inline: null },
    ...more,
  } as unknown as Store;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("What goes in a cart");
  is("a product the creator ships, at one price", cartable(physical("box", ["US"], 500)), true);
  is("not yet one that is limited or has sizes", [cartable(physical("box", ["US"], 500) && { ...physical("box", ["US"], 500), stock: 5 }), cartable({ ...physical("box", ["US"], 500), options: [{}] } as never)], [false, false]);
  is("shipped and online products together are told apart", [shipsWithOnline([product("a"), physical("b", ["US"], 1)]), shipsWithOnline([physical("a", ["US"], 1), physical("b", ["US"], 1)]), shipsWithOnline([product("a"), product("b")])], [true, false, false]);
  is("the shipped ones first, each group in the cart's order", shippedFirst([product("a"), physical("b", ["US"], 1), product("c"), physical("d", ["US"], 1)]).map((p) => p.id), ["b", "d", "a", "c"]);
  is("a line about when it ships only when there is one to say", [sharedShipNote(["Ships in 3 days"]), sharedShipNote(["Ships in 3 days", "Ships in 3 days "]), sharedShipNote(["Ships in 3 days", ""]), sharedShipNote(["A", "B"])], ["Ships in 3 days", "Ships in 3 days", "", ""]);

  part("The checkout");
  await createCartCheckout(shop(), [physical("box", ["US", "CA", "GB"], 700, "Ships in 3 days"), physical("poster", ["GB", "US"], 300, "Ships in 3 days")], "https://marktmorgen.com", { country: "US" });
  let body = sent.at(-1)!;
  is("the order's own product and the one added, in the cart's order", [body.get("metadata[product]"), body.get("metadata[bump]")], ["box", "poster"]);
  is("an address only where both ship, once each", body.getAll("shipping_address_collection[allowed_countries][0]").concat(body.getAll("shipping_address_collection[allowed_countries][1]"), body.getAll("shipping_address_collection[allowed_countries][2]")), ["US", "GB"]);
  is("each one's shipping added on one line, with the line they share", [body.get("shipping_options[0][shipping_rate_data][type]"), body.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"), body.get("shipping_options[0][shipping_rate_data][fixed_amount][currency]"), body.get("shipping_options[0][shipping_rate_data][display_name]")], ["fixed_amount", "1000", "usd", "Shipping · Ships in 3 days"]);
  is("the order marked as shipped, on the checkout and the payment", [body.get("metadata[ship]"), body.get("payment_intent_data[metadata][ship]")], ["yes", "yes"]);
  is("no tax codes while Stripe Tax is off", [...body.keys()].filter((key) => key.includes("tax_code")), []);
  await createCartCheckout(shop({ tax: { enabled: true, included: false, ids: false, invoices: false } as never }), [physical("box", ["US"], 0, "Ships in 3 days"), physical("poster", ["US"], 0, "Ships in a week")], "https://marktmorgen.com", {});
  body = sent.at(-1)!;
  is("with tax on: the shipping as shipping, each shipped line as goods", [
    body.get("shipping_options[0][shipping_rate_data][tax_code]"),
    body.get("shipping_options[0][shipping_rate_data][tax_behavior]"),
    body.get("line_items[0][price_data][product_data][tax_code]"),
    body.get("line_items[1][price_data][product_data][tax_code]"),
    body.get("line_items[0][price_data][tax_behavior]"),
  ], ["txcd_92010001", "exclusive", "txcd_99999999", "txcd_99999999", "exclusive"]);
  is("free when they all are, and no line about when when they differ", body.get("shipping_options[0][shipping_rate_data][display_name]"), "Free shipping");
  await createCartCheckout(shop({ tax: { enabled: true, included: true, ids: false, invoices: false } as never }), [physical("box", ["US"], 500)], "https://marktmorgen.com", {});
  body = sent.at(-1)!;
  is("tax included in the price: the shipping included the same way", [body.get("shipping_options[0][shipping_rate_data][tax_behavior]"), body.get("line_items[0][price_data][tax_behavior]")], ["inclusive", "inclusive"]);
  await createCartCheckout(shop({ cartDeal: { on: true, min: 2, percent: 10 } }), [physical("box", ["US"], 700), physical("poster", ["US"], 300)], "https://marktmorgen.com", {});
  body = sent.at(-1)!;
  is("the deal for buying more takes off the lines, never the shipping", [body.get("line_items[0][price_data][unit_amount]"), body.get("line_items[1][price_data][unit_amount]"), body.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]")], ["1800", "1800", "1000"]);
  const before = sent.length;
  let refused: unknown = null;
  await createCartCheckout(shop(), [physical("box", ["US"], 500), physical("poster", ["DE"], 500)], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT }).catch((error) => {
    refused = error;
  });
  is("sharing no country: refused, nothing opened", [refused instanceof CartShippingRefused && (refused as CartShippingRefused).why, sent.length], ["apart", before]);
  refused = null;
  await createCartCheckout(shop(), [product("guide"), physical("box", ["US"], 500)], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT }).catch((error) => {
    refused = error;
  });
  is("shipped with online products: refused, nothing opened, until the confirmation email names both", [refused instanceof CartShippingRefused && (refused as CartShippingRefused).why, sent.length], ["mixed", before]);
  await createCartCheckout(shop(), [physical("box", ["US"], 500), physical("poster", ["US"], 500)], "https://marktmorgen.com", {});
  is("shipped products only: no box to start at once needed", [sent.length, sent.at(-1)!.get("metadata[ship]")], [before + 1, "yes"]);
  await createCartCheckout(shop(), [product("a"), product("b")], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  body = sent.at(-1)!;
  is("a digital cart asks for no address, as before", [body.get("metadata[ship]"), [...body.keys()].some((key) => key.startsWith("shipping"))], [null, false]);

  part("The open cart, before paying");
  const OWNER = "maker@example.com";
  await claimHandle(OWNER, "paper", "Paper Makers", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPaper0001", true);
  await setSubscription(OWNER, { customerId: "cus_Paper00001", subscriptionId: "sub_Paper00001", active: true, period: paidPeriod() });
  const made: Record<string, string> = {};
  for (const title of ["Guide", "Planner", "Poster", "Mug"]) {
    const added = await addProduct(OWNER, title, "", title === "Guide" ? "19" : "25", null);
    if (!added.ok) throw new Error(`no ${title}`);
    made[title] = added.product.id;
  }
  await setProductLink(OWNER, made.Guide, "https://example.com/guide");
  const shipped = async (title: string, countries: string[], cents: number, note: string) => {
    const result = await setProductShipping(OWNER, made[title], { cents, region: "custom", countries, note });
    if (!result.ok) throw new Error(`no shipping on ${title}`);
  };
  await shipped("Planner", ["US", "CA"], 700, "Ships in 3 days");
  await shipped("Poster", ["US", "GB"], 0, "");
  await shipped("Mug", ["DE"], 500, "");
  const open = async (ids: string[], country = "") => {
    const answer = await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=paper&ids=${ids.join(",")}`, { headers: country ? { "x-vercel-ip-country": country } : {} }));
    return (await answer.json()) as {
      items: { id: string; ok: boolean; ships: string | null }[];
      total: string;
      shipping: { amount: string | null; label: string; where: string; notTo: string | null } | null;
      apart: { ids: string[]; why: string } | null;
      digital: boolean;
    };
  };
  let cart = await open([made.Planner, made.Poster], "US");
  is("each product in it with its own shipping and line about when", cart.items.map((item) => [item.ok, item.ships]), [[true, "+ $7 shipping · Ships in 3 days"], [true, "Free shipping"]]);
  is("shipping and where it can go, the total Stripe will charge before tax, no box to start at once", [cart.shipping, cart.total, cart.apart, cart.digital], [{ amount: "$7", label: "Shipping", where: "Ships to: United States", notTo: null }, "$57", null, false]);
  cart = await open([made.Guide, made.Planner], "US");
  is("shipped with online products: said, and nothing to pay for until one kind is taken out", cart.apart?.why, "Shipped products and products you get online cannot be paid for together in one cart. Remove one kind to check out, and buy the others separately.");
  await setCartDeal(OWNER, { on: true, min: 2, percent: 10 });
  cart = await open([made.Planner, made.Poster], "US");
  is("with the deal: the saving without the shipping, the total with it", [(cart as unknown as { deal: { saved: string } }).deal.saved, cart.total], ["$5", "$52"]);
  await setCartDeal(OWNER, { on: false, min: 2, percent: 10 });
  cart = await open([made.Planner, made.Poster], "BR");
  is("the visitor's country, when it is not one of them", cart.shipping?.notTo, "Brazil is not one of them.");
  cart = await open([made.Planner, made.Poster, made.Mug], "US");
  is("sharing no country: which to take out, by name", cart.apart, { ids: [made.Mug], why: "Mug cannot ship with the rest of your cart (shipping to: United States). Remove it to check out, and buy it from its own page." });

  part("Paying for a cart that cannot ship together");
  const pay = async (ids: string[]) => {
    const form = new URLSearchParams({ handle: "paper" });
    for (const id of ids) form.append("id", id);
    const answer = await payCart(new NextRequest("https://marktmorgen.com/api/store/cart", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", "x-vercel-ip-country": "US" }, body: form.toString() }));
    const where = new URL(answer.headers.get("location") ?? "https://x/");
    return [answer.status, where.hostname === "checkout.stripe.com" ? "stripe" : where.search];
  };
  const opened = sent.length;
  is("two that share a country open Stripe's page, with no box to start at once", [await pay([made.Planner, made.Poster]), sent.length], [[303, "stripe"], opened + 1]);
  is("two that share none go back to the cart, which says why, and open nothing", [await pay([made.Planner, made.Mug]), sent.length], [[303, "?cart=changed"], opened + 1]);
  is("nor a shipped product with an online one", [await pay([made.Guide, made.Planner]), sent.length], [[303, "?cart=changed"], opened + 1]);

  part("After paying");
  const thanks = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  const box = thanks.slice(thanks.indexOf("{t.alsoYours}"));
  is("a second shipped product's box says it goes to the same address, on an order that was shipped", box.indexOf("wasShipped(order.record) && activeShipping(added.product)") > 0 && box.indexOf("alsoShips(store.name)") < box.indexOf("nothingAttached"), true);

  done();
}

void main();
