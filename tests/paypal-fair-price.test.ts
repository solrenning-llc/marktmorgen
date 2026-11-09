/**
 * A fair price by country on a product sold through PayPal (audit R42, item 4).
 *
 * The product page shows the visitor's fair price in the price pill and in the
 * note under the PayPal button (components/store-product.tsx: offNow, SaleNote),
 * as it does beside Stripe's checkout. What PayPal is asked for (payPalPrice,
 * openOrder in lib/paypal-sales.ts) must be that same price, from the same
 * trusted country (the x-vercel-ip-country header the Stripe checkout reads),
 * never from anything in the form. The order keeps which discount it was, so
 * the store's numbers say "fair price", as for a Stripe checkout.
 *
 * Synthetic store, Redis stub and a stand-in for PayPal's API only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setFair, setPayPalSeller, setProductLink, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { offNow, SaleNote } from "@/components/store-product";
import { payPalPrice } from "@/lib/paypal-sales";
import { salePrice } from "@/lib/store-sale";
import { redisPipeline } from "@/lib/redis";
import { POST as payPayPal } from "@/app/api/store/paypal/checkout/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";

process.env.PAYPAL_PARTNER_CLIENT_ID = "partner_client_fair";
process.env.PAYPAL_PARTNER_SECRET = "partner_secret_fair";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERFAIR01";
process.env.PAYPAL_BN_CODE = "marktmorgen_test_bn";
delete process.env.PAYPAL_ENV;

const OWNER = "owner-paypal-fair@example.com";
const sent: { id: string; value: string }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api-m.paypal.com" && url.pathname === "/v1/oauth2/token") return Response.json({ access_token: "synthetic_paypal_token", expires_in: 3_600 });
  if (url.hostname === "api-m.paypal.com" && url.pathname === "/v2/checkout/orders" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { purchase_units: { amount: { value: string } }[] };
    const id = `FAIRORDER${String(sent.length + 1).padStart(6, "0")}`;
    sent.push({ id, value: body.purchase_units[0].amount.value });
    return Response.json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: `https://www.paypal.com/checkoutnow?token=${id}` }] });
  }
  return Response.json({}, { status: 404 });
}) as typeof fetch;

type Kept = { c: number; off?: number; sale?: number; meta?: Record<string, string> };

/** Posts the PayPal button's form; `country` is what the edge says, `formCountry` a field the page never sends. */
async function buy(store: Store, product: string, country: string | null, formCountry = ""): Promise<{ value: string | null; kept: Kept | null }> {
  const before = sent.length;
  const form = withConsent(new URLSearchParams({ handle: store.handle, product }));
  if (formCountry) form.set("country", formCountry);
  const headers: Record<string, string> = { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded" };
  if (country !== null) headers["x-vercel-ip-country"] = country;
  try {
    await payPayPal(new NextRequest("https://marktmorgen.com/api/store/paypal/checkout", { method: "POST", headers, body: form.toString() }));
  } catch (error) {
    // Outside Next's request scope, the visit count the route schedules with `after` throws; the order is opened and kept before it.
    if (!/outside a request scope/.test(String(error))) throw error;
  }
  if (sent.length === before) return { value: null, kept: null };
  const order = sent[sent.length - 1];
  const [raw] = await redisPipeline([["GET", `nl:ppsell:o:${order.id}`]]);
  return { value: order.value, kept: typeof raw === "string" ? (JSON.parse(raw) as Kept) : null };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "ppfair", "PP Fair", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PPFair00001", subscriptionId: "sub_PPFair00001", active: true, period: paidPeriod() });
  await setPayPalSeller(OWNER, "SELLERFAIR001");
  const made = await addProduct(OWNER, "Guide", "", "40", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  await setFair(OWNER, { on: true, auto: false, maxOff: 50, levels: { IN: 50 }, all: true, products: [] });
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  is("the store sells through PayPal only, with a fair price of 50% for India", [Boolean(store.paypalSeller), store.stripeAccountId ?? null, store.fair.on, store.fair.levels.IN], [true, null, true, 50]);

  part("The page and PayPal say the same price");
  const visitor = { ...store, visitorCountry: "IN" } as Store;
  const shown = salePrice(product.priceCents, offNow(visitor, product));
  const note = renderToStaticMarkup(createElement(SaleNote, { store: visitor, product })).replace(/<[^>]+>/g, " ");
  is("the note under the PayPal button promises the fair price", /fair price for India: 50% off/i.test(note), true);
  is("what the pill and the note promise is what PayPal is asked for", payPalPrice(visitor, product), shown);
  is("a visitor elsewhere: the full price on both", [payPalPrice({ ...store, visitorCountry: "US" } as Store, product), salePrice(product.priceCents, offNow({ ...store, visitorCountry: "US" } as Store, product))], [4000, 4000]);

  part("The order PayPal is sent");
  const india = await buy(store, product.id, "IN");
  is("a buyer whose connection is in India is charged the fair price", india.value, "20.00");
  is("the order keeps it as a fair price, not a store sale", [india.kept?.c, india.kept?.off, india.kept?.sale ?? null, india.kept?.meta?.fair], [2000, 2000, null, "IN:50"]);
  const elsewhere = await buy(store, product.id, "US");
  is("a buyer elsewhere: the full price, nothing noted", [elsewhere.value, elsewhere.kept?.off ?? null, elsewhere.kept?.meta?.fair ?? null], ["40.00", null, null]);
  const forged = await buy(store, product.id, null, "IN");
  is("the country is never read from the form: no edge country, full price", [forged.value, forged.kept?.meta?.fair ?? null], ["40.00", null]);

  part("A running store sale and a fair price: the larger one, never both");
  const now = Math.floor(Date.now() / 1000);
  const withSale = (percent: number) => ({ ...store, sale: { ...store.sale, name: "Spring", percent, starts: now - 60, ends: now + 3600, all: true, products: [], coupon: "c_sale" } }) as Store;
  is("sale 20%, fair 50% in India: 50% off", payPalPrice({ ...withSale(20), visitorCountry: "IN" } as Store, product), 2000);
  is("sale 60%, fair 50% in India: 60% off", payPalPrice({ ...withSale(60), visitorCountry: "IN" } as Store, product), 1600);
  is("sale 20% elsewhere: 20% off, as before", payPalPrice({ ...withSale(20), visitorCountry: "US" } as Store, product), 3200);
  is("no country known: the sale alone, as before", payPalPrice(withSale(20), product), 3200);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
