/**
 * 789 [IV1] step 3, unit 3 (lib/eu-vat-collect.ts euCartGate and applyEuCollectCart; the owner's order to Claude 4
 * 5BC, 21/11/2026): EU and UK VAT collected on top of a cart's lines, through the platform's fee, once the record says
 * "collect" and the whole switch is on. It holds that:
 *   - with the real values (DEEMED_SUPPLIER_RECORDS empty, both switches off) the cart gate answers exactly what the
 *     route's loop over consumerGate answered, the route opens the same checkout, and createCartCheckout is never
 *     handed euVat;
 *   - with a collect record and the switch injected HERE ONLY, a cart whose products all agree on one country is
 *     collected, and any other cart is refused as today;
 *   - the VAT goes on top of the sum of the lines, as one line, through one fee, never out of the share or revenue;
 *   - every unknown refuses before Stripe is asked, with the body untouched and the held unit given back.
 * The creator's Stripe account is a stand-in for `fetch`; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setCurrency, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { POST as cartRoute } from "@/app/api/store/cart/route";
import { createCartCheckout } from "@/lib/cart-checkout";
import { consumerGate } from "@/lib/eu-vat-gate";
import { EuVatCollectRefused, applyEuCollect, applyEuCollectCart, euCartGate } from "@/lib/eu-vat-collect";
import { DEEMED_SUPPLIER_RECORDS } from "@/lib/deemed-supplier";
import { EU_VAT_COLLECT_REVIEWED, UK_VAT_COLLECT_REVIEWED } from "@/lib/vat-registrations";
import type { EuSupplyFields } from "@/lib/eu-vat-supply";
import { TEST_CONSENT, withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_eu_vat_collect_cart_only";

const sessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    sessions.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"k".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

// Injected in this file only, never in a fixture another test imports.
const NOW = new Date("2026-12-01T12:00:00Z");
const RATES = [
  { country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-20" },
  { country: "FR", basisPoints: 2000, source: "https://example.invalid/fr", readOn: "2026-11-20" },
];
const RECORD = { treatment: "collect", implementedIn: "lib/eu-vat-collect.ts", recordedOn: "2026-11-25", evidence: "tests/eu-vat-collect-cart.test.ts" };
const RECORDS = [
  { ...RECORD, jurisdiction: "EU", registration: "IE OSS" },
  { ...RECORD, jurisdiction: "UK", registration: "UK VAT 123456789" },
];
const SWITCH = {
  reviewed: true,
  seller: { legalName: "Synthetic Seller LLC", address: "1 Test Street, Wilmington, DE 19801, United States" },
  eu: { memberState: "IE", vatNumber: "EU372000019", effectiveFrom: "2026-11-01" },
  uk: { vatNumber: "123456789", effectiveFrom: "2026-11-01" },
  reviews: [
    { jurisdiction: "EU", registration: "EU372000019", reviewedOn: "2026-11-15", reviewer: "owner" },
    { jurisdiction: "UK", registration: "123456789", reviewedOn: "2026-11-15", reviewer: "owner" },
  ],
};
const ON = { records: RECORDS, vatSwitch: SWITCH, now: NOW, rates: RATES };

// The creator answered that it is not an e-publication (unit 5a): without that answer, nothing collects.
const ESS: EuSupplyFields = { priceCents: 2900, file: null, link: "https://example.com/pack", keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null, publication: false };
const ESS2: EuSupplyFields = { ...ESS, priceCents: 1500, link: "https://example.com/second" };
const GOODS: EuSupplyFields = { ...ESS, link: null, shipping: { countries: ["DE"] } };
const evidence = (ip: string | null, billing: string | null) => {
  const headers = new Headers();
  if (ip) headers.set("x-vercel-ip-country", ip);
  const form = new URLSearchParams();
  if (billing) form.set("billing_country", billing);
  return { headers, form };
};
/** The route's loop before this unit: the first refusal of consumerGate, product by product, or go on. */
const oldLoop = (products: EuSupplyFields[], sent: ReturnType<typeof evidence>) => {
  for (const product of products) {
    const gate = consumerGate({ product, ...sent });
    if (!gate.ok) return gate;
  }
  return { ok: true, collect: null };
};

/** A built cart body, as createCartCheckout leaves it after the share, the tax settings and the currency. */
const cartBody = (amounts: number[] = [2900, 1500], currency = "eur") => {
  const body = new URLSearchParams({ mode: "payment", "automatic_tax[enabled]": "true", "adaptive_pricing[enabled]": "false" });
  amounts.forEach((cents, i) => {
    body.set(`line_items[${i}][quantity]`, "1");
    body.set(`line_items[${i}][price_data][currency]`, currency);
    body.set(`line_items[${i}][price_data][unit_amount]`, String(cents));
    body.set(`line_items[${i}][price_data][product_data][name]`, `Product ${i + 1}`);
  });
  return body;
};
const tryCart = (body: URLSearchParams, extra: Partial<Parameters<typeof applyEuCollectCart>[1]> = {}) => {
  try {
    applyEuCollectCart(body, { country: "DE", buyerCurrencyLive: false, costsCents: () => 12, now: NOW, rates: RATES, ...extra });
    return "ok";
  } catch (error) {
    return error instanceof EuVatCollectRefused ? "refused" : `threw ${String(error)}`;
  }
};
/** Refused, with the body exactly as it was. */
const refusedUntouched = (body: URLSearchParams, extra: Partial<Parameters<typeof applyEuCollectCart>[1]> = {}) => {
  const before = body.toString();
  return [tryCart(body, extra), body.toString() === before];
};

const SHOP = "vatcollectcart";
const askCart = (ip: string | null, ids: string[], fields: Record<string, string>) => {
  const form = withConsent(new FormData());
  form.set("handle", SHOP);
  for (const id of ids) form.append("id", id);
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const headers: Record<string, string> = { host: "marktmorgen.com" };
  if (ip) headers["x-vercel-ip-country"] = ip;
  return new NextRequest("https://marktmorgen.com/api/store/cart", { method: "POST", body: form, headers });
};

async function main(): Promise<void> {
  part("Nothing collects today: the real values");
  is("no deemed-supplier record and both switches off", [DEEMED_SUPPLIER_RECORDS.length, EU_VAT_COLLECT_REVIEWED, UK_VAT_COLLECT_REVIEWED], [0, false, false]);
  for (const [ip, billing] of [["US", "US"], ["DE", "DE"], ["FR", "FR"], ["GB", "GB"], ["US", "FR"], ["DE", null], [null, null], ["CA", "CA"]] as const) {
    for (const products of [[ESS], [ESS, ESS2], [ESS, GOODS]]) {
      const sent = evidence(ip, billing);
      is(`IP ${ip ?? "-"}, billing ${billing ?? "-"}, ${products.length} product(s): exactly the old loop`, euCartGate({ products, ...sent }), oldLoop(products, sent));
    }
  }

  part("Collect on, injected here only: which carts collect");
  is("two electronic products, a German buyer: collected in Germany", euCartGate({ products: [ESS, ESS2], ...evidence("DE", "DE"), ...ON }), { ok: true, collect: { country: "DE" } });
  is("two electronic products, a UK buyer: collected in the UK", euCartGate({ products: [ESS, ESS2], ...evidence("GB", "GB"), ...ON }), { ok: true, collect: { country: "GB" } });
  is("a product that ships in the cart: refused as today", euCartGate({ products: [ESS, GOODS], ...evidence("DE", "DE"), ...ON }), consumerGate({ product: GOODS, ...evidence("DE", "DE") }));
  is("the UK with an unclassified product: refused as today", euCartGate({ products: [{ ...ESS, publication: undefined }, { ...ESS2, publication: undefined }], ...evidence("GB", "GB"), ...ON }), consumerGate({ product: ESS, ...evidence("GB", "GB") }));
  is("evidence that disagrees: refused as today", euCartGate({ products: [ESS, ESS2], ...evidence("DE", "FR"), ...ON }), consumerGate({ product: ESS, ...evidence("DE", "FR") }));
  is("a US buyer: goes on with nothing collected", euCartGate({ products: [ESS, ESS2], ...evidence("US", "US"), ...ON }), { ok: true, collect: null });
  is("no billing country: asked for it, as today", euCartGate({ products: [ESS, ESS2], ...evidence("DE", null), ...ON }), consumerGate({ product: ESS, ...evidence("DE", null) }));

  part("The VAT on top of the cart's lines");
  const body = cartBody();
  is("two lines in euros: collected", tryCart(body), "ok");
  is("19% on the sum of the lines (2900 + 1500 = 4400 → 836), as one more line", [body.get("line_items[0][price_data][unit_amount]"), body.get("line_items[1][price_data][unit_amount]"), body.get("line_items[2][price_data][unit_amount]")], ["2900", "1500", "836"]);
  is("the fee is the VAT and its cost, never the share or the revenue", body.get("payment_intent_data[application_fee_amount]"), String(836 + 12));
  is("marked eu_vat, and the creator's automatic tax off for this sale", [body.get("payment_intent_data[metadata][eu_vat]"), body.has("automatic_tax[enabled]")], ["DE:1900:836", false]);
  const uk = cartBody([2900, 1500], "gbp");
  is("a UK cart in pounds: 20% on the sum, marked uk_vat", [tryCart(uk, { country: "GB" }), uk.get("line_items[2][price_data][unit_amount]"), uk.get("payment_intent_data[metadata][uk_vat]"), uk.has("payment_intent_data[metadata][eu_vat]")], ["ok", "880", "GB:2000:880", false]);
  const one = cartBody([2900]);
  is("a cart of one product: collected as a one-off sale would be", [tryCart(one), one.get("line_items[1][price_data][unit_amount]")], ["ok", "551"]);

  part("Every unknown refuses, with the body untouched");
  is("no reviewed cost of receiving the VAT: refused, never zero", refusedUntouched(cartBody(), { costsCents: undefined }), ["refused", true]);
  is("a negative cost: refused", refusedUntouched(cartBody(), { costsCents: () => -1 }), ["refused", true]);
  is("no sourced rate for the country: refused", refusedUntouched(cartBody(), { country: "IT" }), ["refused", true]);
  // Since unit 7 HMRC's period rates are read; a month with no rate is given here as an empty table.
  is("a UK cart in euros (no sterling rate): refused", refusedUntouched(cartBody(), { country: "GB", sterlingRates: [] }), ["refused", true]);
  is("the buyer's currency conversion live: refused", refusedUntouched(cartBody(), { buyerCurrencyLive: true }), ["refused", true]);
  const box = cartBody();
  box.set("allow_promotion_codes", "true");
  is("a code box (a code could change the amount after): refused", refusedUntouched(box), ["refused", true]);
  const code = cartBody();
  code.set("discounts[0][promotion_code]", "promo_1");
  is("a code from a link: refused", refusedUntouched(code), ["refused", true]);
  const shipped = cartBody();
  shipped.set("shipping_address_collection[allowed_countries][0]", "DE");
  is("shipping: refused", refusedUntouched(shipped), ["refused", true]);
  const two = cartBody();
  two.set("line_items[1][quantity]", "2");
  is("a quantity other than one: refused", refusedUntouched(two), ["refused", true]);
  const mixed = cartBody();
  mixed.set("line_items[1][price_data][currency]", "usd");
  is("lines in different currencies: refused", refusedUntouched(mixed), ["refused", true]);
  const gap = cartBody();
  for (const key of [...gap.keys()]) if (key.startsWith("line_items[1]")) gap.delete(key);
  gap.set("line_items[2][quantity]", "1");
  gap.set("line_items[2][price_data][currency]", "eur");
  gap.set("line_items[2][price_data][unit_amount]", "100");
  is("lines numbered with a gap: refused", refusedUntouched(gap), ["refused", true]);
  const converted = cartBody();
  converted.delete("adaptive_pricing[enabled]");
  is("Stripe's conversion not set off: refused", refusedUntouched(converted), ["refused", true]);
  is("more lines than a cart holds: refused", refusedUntouched(cartBody([100, 100, 100, 100, 100])), ["refused", true]);
  // The one-off checkout shares these checks (collectOn): it still takes one line only, never a cart's two.
  const oneOff = cartBody();
  const oneOffBefore = oneOff.toString();
  const oneOffAnswer = (() => {
    try {
      applyEuCollect(oneOff, { country: "DE", chooseYourPrice: false, buyerCurrencyLive: false, costsCents: () => 12, now: NOW, rates: RATES });
      return "ok";
    } catch (error) {
      return error instanceof EuVatCollectRefused ? "refused" : String(error);
    }
  })();
  is("the one-off checkout handed two lines: refused, the body untouched", [oneOffAnswer, oneOff.toString() === oneOffBefore], ["refused", true]);

  part("The route and createCartCheckout, with the Stripe stand-in");
  redis.clear();
  const owner = "vatcollectcart@example.com";
  await claimHandle(owner, SHOP, "VAT Collect Cart", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestVatCart01", true);
  await setSubscription(owner, { customerId: "cus_VatCart00001", subscriptionId: "sub_VatCart00001", active: true, period: paidPeriod() });
  const ids: string[] = [];
  for (const [title, price, link] of [["Pattern pack", "29", "https://example.com/pack"], ["Stitch guide", "15", "https://example.com/guide"]]) {
    const made = await addProduct(owner, title, "", price, null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(owner, made.product.id, link);
    ids.push(made.product.id);
  }
  const where = (response: Response) => [response.status, response.headers.get("location")];
  let before = sessions.length;
  is("an EU cart today: back to the cart with abroad, Stripe not asked", [...where(await cartRoute(askCart("DE", ids, { billing_country: "DE" }))), sessions.length - before], [303, `https://marktmorgen.com/@${SHOP}?cart=abroad#cart`, 0]);
  before = sessions.length;
  await cartRoute(askCart("US", ids, { billing_country: "US" }));
  const sent = sessions.at(-1)!;
  is("a US cart: Stripe's page opens once", sessions.length - before, 1);
  is("with two lines, no VAT line, no VAT mark and no fee, as before", [sent.has("line_items[1][price_data][unit_amount]"), sent.has("line_items[2][price_data][unit_amount]"), sent.has("payment_intent_data[metadata][eu_vat]"), sent.has("payment_intent_data[metadata][uk_vat]"), sent.has("payment_intent_data[application_fee_amount]")], [true, false, false, false, false]);
  const route = readFileSync("app/api/store/cart/route.ts", "utf8");
  is("the route asks the cart gate, not consumerGate product by product", [/const gate = euCartGate\(\{ products, headers: request\.headers, form: sent \}\);/.test(route), /consumerGate\(/.test(route)], [true, false]);
  is("and hands createCartCheckout euVat only when the gate said to collect", /\.\.\.\(gate\.collect \? \{ euVat: \{ country: gate\.collect\.country \} \} : \{\}\),/.test(route), true);
  is("a refusal for the VAT gives back the held units", /error instanceof CartShippingRefused \|\| error instanceof EuVatCollectRefused\);/.test(route), true);
  is("and the hold count, and goes back to the cart with abroad", [/if \(charged && \([^)]*error instanceof EuVatCollectRefused\)\) await giveBackHold\(/.test(route), /if \(error instanceof EuVatCollectRefused\) return away\(`\/@\$\{store\.handle\}\?cart=abroad#cart`\);/.test(route)], [true, true]);
  const checkout = readFileSync("lib/cart-checkout.ts", "utf8");
  is("createCartCheckout touches the body for VAT only when handed euVat, after the currency is set", (checkout.match(/applyEuCollectCart\(/g) ?? []).length === 1 && /inTheCurrencyShown\(body\);\n(?:  (?:\/\/|const vat)[^\n]*\n){2,6}  if \(extras\.euVat\) applyEuCollectCart\(body,/.test(checkout), true);

  const store = (await storeForEmail(owner))!;
  const products = await Promise.all(ids.map(async (id) => (await readProduct(store, id))!));
  await createCartCheckout(store, products, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  const without = sessions.at(-1)!.toString().replace(/expires_at=\d+/, "");
  await createCartCheckout(store, products, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT, euVat: undefined });
  is("createCartCheckout with euVat undefined sends the same body, byte for byte", sessions.at(-1)!.toString().replace(/expires_at=\d+/, ""), without);
  before = sessions.length;
  const refused = await createCartCheckout(store, products, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT, euVat: { country: "DE", now: NOW, rates: RATES } }).then(() => "opened", (error: unknown) => (error instanceof EuVatCollectRefused ? "refused" : String(error)));
  is("handed euVat with no reviewed cost: refused, Stripe never asked", [refused, sessions.length - before], ["refused", 0]);
  before = sessions.length;
  await createCartCheckout(store, products, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT, euVat: { country: "DE", now: NOW, rates: RATES, costsCents: () => 12 } });
  const collected = sessions.at(-1)!;
  is("handed euVat with a cost: Stripe asked once", sessions.length - before, 1);
  is("the VAT line on top of the two products' own amounts", [collected.get("line_items[0][price_data][unit_amount]"), collected.get("line_items[1][price_data][unit_amount]"), collected.get("line_items[2][price_data][unit_amount]")], ["2900", "1500", "836"]);
  is("the fee of the VAT and its cost, and no automatic tax from the creator's account", [collected.get("payment_intent_data[application_fee_amount]"), collected.has("automatic_tax[enabled]")], [String(836 + 12), false]);

  part("A UK cart in euros: the expiry sent is the one the sterling month was checked for (B1, Claude 1 A's note 1 on #5032)");
  // The clock is fixed on the month's last day at noon UTC; the November row of HMRC_PERIOD_RATES is the real one.
  const realNow = Date.now;
  let clock = Date.parse("2026-11-30T12:00:00Z");
  Date.now = () => clock;
  try {
    await setCurrency(owner, "eur");
    const euroStore = (await storeForEmail(owner))!;
    const euroProducts = await Promise.all(products.map(async (p) => (await readProduct(euroStore, p.id))!));
    const open = (extras: Record<string, unknown>, costsCents: () => number = () => 12) =>
      createCartCheckout(euroStore, euroProducts, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT, euVat: { country: "GB", now: new Date(clock), costsCents }, ...extras })
        .then(() => "opened", (error: unknown) => (error instanceof EuVatCollectRefused ? "refused" : String(error)));
    const checkedAt = Math.floor(clock / 1000);
    before = sessions.length;
    is("RED: a held cart on the month's last day at noon: opened", [await open({ held: true }), sessions.length - before], ["opened", 1]);
    const held = sessions.at(-1)!;
    is("collected at November's rate, closing in its own 31 minutes, inside the window checked", [held.get("payment_intent_data[metadata][uk_vat_gbp]")?.endsWith(":2026-11"), Number(held.get("expires_at")) - checkedAt <= 31 * 60 + 300], [true, true]);
    before = sessions.length;
    is("without a held unit, on the same day: Stripe's day reaches December, refused, Stripe not asked", [await open({}), sessions.length - before], ["refused", 0]);
    before = sessions.length;
    const slow = () => {
      clock += 6 * 60 * 1000;
      return 12;
    };
    is("a held cart whose expiry would pass the window checked: refused before Stripe is asked", [await open({ held: true }, slow), sessions.length - before], ["refused", 0]);
  } finally {
    Date.now = realNow;
  }

  done();
}

void main();
