/**
 * 789 [IV1] step 3, unit 2 (lib/eu-vat-collect.ts; coordinator C5-20261120-2130): UK VAT collected on top of the price
 * on the one-off card checkout, through the platform's fee, once the UK record says "collect" and the UK's whole switch
 * is on. It holds that:
 *   - with the real values (DEEMED_SUPPLIER_RECORDS empty, UK_VAT_COLLECT_REVIEWED false) a UK buyer is refused exactly
 *     as consumerGate refuses them today, and the route sends them back with nothing asked of Stripe;
 *   - with a UK collect record and the switch injected HERE ONLY, a buyer whose two items agree on GB is collected, for
 *     an electronically supplied service explicitly classified as not an e-publication, and every other buyer is
 *     refused as today;
 *   - the two unknowns this unit adds refuse, never collect zero: an unclassified product (e-publication or not) and a
 *     sale in another currency than pounds (no sterling rate);
 *   - the VAT goes on top of the line's real amount at 20%, through the fee, marked `uk_vat` and never `eu_vat`.
 * The creator's Stripe account is a stand-in for `fetch`; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setCurrency, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { createCheckout } from "@/lib/store-checkout";
import { consumerGate } from "@/lib/eu-vat-gate";
import { EuVatCollectRefused, applyEuCollect, euSaleGate } from "@/lib/eu-vat-collect";
import { DEEMED_SUPPLIER_RECORDS } from "@/lib/deemed-supplier";
import { UK_VAT_COLLECT_REVIEWED } from "@/lib/vat-registrations";
import { UK_VAT_RATE_VALID_UNTIL } from "@/lib/uk-vat";
import type { EuSupplyFields } from "@/lib/eu-vat-supply";
import { TEST_CONSENT, withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_uk_vat_collect_card_only";

const sessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    sessions.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"u".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

// Injected in this file only, never in a fixture another test imports (coordinator's condition). The day is before
// UK_VAT_RATE_VALID_UNTIL, so the rate read on gov.uk still holds; the registration and review are synthetic.
const NOW = new Date("2026-12-01T12:00:00Z");
const UK_RECORD = { jurisdiction: "UK", treatment: "collect", implementedIn: "lib/eu-vat-collect.ts", recordedOn: "2026-11-25", registration: "UK VAT 123456789", evidence: "tests/uk-vat-collect-card.test.ts" };
const EU_RECORD = { ...UK_RECORD, jurisdiction: "EU", registration: "IE OSS", evidence: "tests/eu-vat-collect-card.test.ts" };
const SWITCH = {
  reviewed: true,
  seller: { legalName: "Synthetic Seller LLC", address: "1 Test Street, Wilmington, DE 19801, United States" },
  uk: { vatNumber: "123456789", effectiveFrom: "2026-11-01" },
  reviews: [{ jurisdiction: "UK", registration: "123456789", reviewedOn: "2026-11-15", reviewer: "owner" }],
};
const ON = { records: [UK_RECORD], vatSwitch: SWITCH, now: NOW };
/** The day after the UK rate's review date. */
const LATE = new Date(Date.parse(`${UK_VAT_RATE_VALID_UNTIL}T12:00:00Z`) + 86_400_000);

// The creator answered that it is not an e-publication (unit 5a): without that answer, nothing collects.
const ESS: EuSupplyFields = { priceCents: 2900, file: null, link: "https://example.com/pack", keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null, publication: false };
const GOODS: EuSupplyFields = { ...ESS, link: null, shipping: { countries: ["GB"] } };
const evidence = (ip: string | null, billing: string | null) => {
  const headers = new Headers();
  if (ip) headers.set("x-vercel-ip-country", ip);
  const form = new URLSearchParams();
  if (billing) form.set("billing_country", billing);
  return { headers, form };
};
const GB = evidence("GB", "GB");
const COLLECT = { ok: true, collect: { country: "GB" } };

/** A built one-off body, as createCheckout leaves it after the share. */
const plainBody = (currency = "gbp", cents = 2900) =>
  new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": currency,
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": "Pattern pack",
    "automatic_tax[enabled]": "true",
    "adaptive_pricing[enabled]": "false",
  });
const tryCollect = (body: URLSearchParams, extra: Partial<Parameters<typeof applyEuCollect>[1]> = {}) => {
  try {
    applyEuCollect(body, { country: "GB", chooseYourPrice: false, buyerCurrencyLive: false, costsCents: () => 12, now: NOW, ...extra });
    return "ok";
  } catch (error) {
    return error instanceof EuVatCollectRefused ? "refused" : `threw ${String(error)}`;
  }
};

const SHOP = "ukvatcollectshop";
const ask = (ip: string | null, fields: Record<string, string>) => {
  const form = withConsent(new FormData());
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const headers: Record<string, string> = { host: "marktmorgen.com" };
  if (ip) headers["x-vercel-ip-country"] = ip;
  return new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: form, headers });
};

async function main(): Promise<void> {
  part("Nothing collects today: the real values");
  is("no deemed-supplier record and the UK switch off", [DEEMED_SUPPLIER_RECORDS.length, UK_VAT_COLLECT_REVIEWED], [0, false]);
  const base = consumerGate({ product: ESS, ...GB });
  is("a UK buyer: exactly consumerGate's refusal", euSaleGate({ product: ESS, ...GB }), base);
  is("and consumerGate refuses them", base.ok, false);
  is("even a product classified as not an e-publication: the real switch is off", euSaleGate({ product: ESS, ...GB }), base);

  part("The UK on, injected here only: who is collected");
  is("both items in GB, an electronic service, not an e-publication: collected", euSaleGate({ product: ESS, ...GB, ...ON }), COLLECT);
  // RED → GREEN: unknown classification refuses, never collects at zero or at 20% on a guess.
  is("the product's classification unknown: refused as today", euSaleGate({ product: { ...ESS, publication: undefined }, ...GB, ...ON }), base);
  is("an e-publication (zero-rated in the UK): refused as today", euSaleGate({ product: { ...ESS, publication: true }, ...GB, ...ON }), base);
  is("the IP in GB, the billing country in France: refused as today", euSaleGate({ product: ESS, ...evidence("GB", "FR"), ...ON }), consumerGate({ product: ESS, ...evidence("GB", "FR") }));
  is("the Isle of Man: refused as today", euSaleGate({ product: ESS, ...evidence("IM", "IM"), ...ON }), consumerGate({ product: ESS, ...evidence("IM", "IM") }));
  is("goods shipped to the UK: refused as today", euSaleGate({ product: GOODS, ...GB, ...ON }), consumerGate({ product: GOODS, ...GB }));
  is("past the rate's review date: refused as today", euSaleGate({ product: ESS, ...GB, ...ON, now: LATE }), base);
  is("no UK registration in the switch: refused as today", euSaleGate({ product: ESS, ...GB, ...ON, vatSwitch: { ...SWITCH, uk: { vatNumber: "", effectiveFrom: "" } } }), base);
  is("only the EU recorded as collect: a UK buyer refused as today", euSaleGate({ product: ESS, ...GB, ...ON, records: [EU_RECORD] }), base);
  is("a German buyer with only the UK on: refused as today", euSaleGate({ product: ESS, ...evidence("DE", "DE"), ...ON }), consumerGate({ product: ESS, ...evidence("DE", "DE") }));
  is("a US buyer: goes on with nothing collected", euSaleGate({ product: ESS, ...evidence("US", "US"), ...ON }), { ok: true, collect: null });
  is("no billing country: asked for it, as today", euSaleGate({ product: ESS, ...evidence("GB", null), ...ON }), consumerGate({ product: ESS, ...evidence("GB", null) }));

  part("The VAT on top, in pounds, marked for the UK return");
  const body = plainBody();
  is("a plain one-off in pounds: collected", tryCollect(body), "ok");
  is("20% on the line's own amount (2900 → 580)", [body.get("line_items[0][price_data][unit_amount]"), body.get("line_items[1][price_data][unit_amount]")], ["2900", "580"]);
  is("named for the buyer", body.get("line_items[1][price_data][product_data][name]"), "VAT (United Kingdom, 20%)");
  is("the fee is the VAT and its cost, so it never comes out of the share or the revenue", body.get("payment_intent_data[application_fee_amount]"), String(580 + 12));
  is("marked uk_vat, never eu_vat", [body.get("payment_intent_data[metadata][uk_vat]"), body.has("payment_intent_data[metadata][eu_vat]")], ["GB:2000:580", false]);
  is("and the creator's own automatic tax off for this sale", body.has("automatic_tax[enabled]"), false);
  // RED → GREEN: a sale in another currency with no sterling rate for its month refuses with the body untouched. Since
  // unit 7 HMRC's period rates are read (lib/hmrc-period-rates.ts, tests/uk-vat-other-currency.test.ts), so the month
  // with no rate is given here as an empty table.
  for (const currency of ["eur", "usd"]) {
    const other = plainBody(currency);
    const before = other.toString();
    is(`a sale in ${currency}: no sterling rate, refused, the body untouched`, [tryCollect(other, { sterlingRates: [] }), other.toString()], ["refused", before]);
  }
  const late = plainBody();
  is("past the rate's review date: refused, the body untouched", [tryCollect(late, { now: LATE }), late.toString()], ["refused", plainBody().toString()]);
  const noCost = plainBody();
  is("no reviewed cost of receiving the VAT: refused, never zero", [tryCollect(noCost, { costsCents: undefined }), noCost.toString()], ["refused", plainBody().toString()]);
  const minus = plainBody();
  is("a negative cost: refused", tryCollect(minus, { costsCents: () => -1 }), "refused");
  is("an EU sale still carries eu_vat, not uk_vat (the EU path unchanged)", (() => {
    const eu = plainBody("eur");
    applyEuCollect(eu, { country: "DE", chooseYourPrice: false, buyerCurrencyLive: false, costsCents: () => 12, now: new Date("2026-12-01T12:00:00Z"), rates: [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-20" }] });
    return [eu.has("payment_intent_data[metadata][eu_vat]"), eu.has("payment_intent_data[metadata][uk_vat]")];
  })(), [true, false]);

  part("The route and createCheckout, with the Stripe stand-in");
  redis.clear();
  const owner = "ukvatcollect@example.com";
  await claimHandle(owner, SHOP, "UK VAT Collect Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestUkVatColl1", true);
  await setSubscription(owner, { customerId: "cus_UkVatCollect01", subscriptionId: "sub_UkVatCollect01", active: true, period: paidPeriod() });
  await setCurrency(owner, "gbp");
  const made = await addProduct(owner, "Pattern pack", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.com/pack");
  const id = made.product.id;
  let before = sessions.length;
  const response = await checkoutRoute(ask("GB", { handle: SHOP, product: id, billing_country: "GB" }));
  is("a UK buyer today: back with abroad, Stripe not asked", [response.status, response.headers.get("location"), sessions.length - before], [303, `https://marktmorgen.com/@${SHOP}/p/${id}?status=abroad#buy`, 0]);
  const store = (await storeForEmail(owner))!;
  const product = (await readProduct(store, id))!;
  before = sessions.length;
  const refused = await createCheckout(store, product, "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT, euVat: { country: "GB", now: NOW } }).then(() => "opened", (error: unknown) => (error instanceof EuVatCollectRefused ? "refused" : String(error)));
  is("handed the UK with no reviewed cost: refused, Stripe never asked", [refused, sessions.length - before], ["refused", 0]);
  before = sessions.length;
  await createCheckout(store, product, "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT, euVat: { country: "GB", now: NOW, costsCents: () => 12 } });
  const collected = sessions.at(-1)!;
  is("handed the UK with a cost: Stripe asked once", sessions.length - before, 1);
  is("in pounds, with the VAT line on top of the product's own amount", [collected.get("line_items[0][price_data][currency]"), collected.get("line_items[0][price_data][unit_amount]"), collected.get("line_items[1][price_data][unit_amount]")], ["gbp", "2900", "580"]);
  is("the fee of the VAT and its cost (the plan's share is 0% today), marked uk_vat", [collected.get("payment_intent_data[application_fee_amount]"), collected.get("payment_intent_data[metadata][uk_vat]")], [String(580 + 12), "GB:2000:580"]);

  done();
}

void main();
