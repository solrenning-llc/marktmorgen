/**
 * 789 [IV1] step 3, unit 1 (lib/eu-vat-collect.ts; coordinator C5-20261120-2100): EU VAT collected on top of the
 * price on the one-off card checkout, through the platform's fee, once the EU record says "collect" and the whole
 * switch is on. It holds that:
 *   - with the real values (DEEMED_SUPPLIER_RECORDS empty, EU_VAT_COLLECT_REVIEWED false) the gate answers exactly what
 *     consumerGate answers, the route opens the same checkout it opens today, and createCheckout is never handed euVat;
 *   - with a collect record and the switch injected HERE ONLY, an EU buyer whose evidence agrees is collected, and
 *     every other buyer is refused as today;
 *   - the VAT goes on top of the line's real amount and through the fee, never out of the share or the revenue;
 *   - every unknown (no reviewed cost of receiving the VAT, no rate, a sale that is not a plain one-off) refuses before
 *     Stripe is asked, with nothing collected at zero.
 * The creator's Stripe account is a stand-in for `fetch`; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { refusedBeforeStripe, stockLeft, withStockHold } from "@/lib/stock";
import { readProduct } from "@/lib/catalog";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { createCheckout } from "@/lib/store-checkout";
import { consumerGate } from "@/lib/eu-vat-gate";
import { EuVatCollectRefused, applyEuCollect, euCartGate, euSaleGate, euVatCollectionCostCents } from "@/lib/eu-vat-collect";
import { DEEMED_SUPPLIER_RECORDS } from "@/lib/deemed-supplier";
import { EU_VAT_COLLECT_REVIEWED, OSS_IDENTIFICATION_CODES, OSS_RETURN_CURRENCY } from "@/lib/vat-registrations";
import { vatCollectionCostOf } from "@/lib/eu-vat-collection-cost";
import type { EuSupplyFields } from "@/lib/eu-vat-supply";
import { EU_VAT_RATES, EU_VAT_RATES_VALID_UNTIL } from "@/lib/eu-vat-amount";
import { TEST_CONSENT, withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_eu_vat_collect_card_only";

const sessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    sessions.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"v".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

// Injected in this file only, never in a fixture another test imports (coordinator's condition).
const NOW = new Date("2027-02-01T12:00:00Z");
const RATES = [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2027-01-20" }];
const RECORDS = [{ jurisdiction: "EU", treatment: "collect", implementedIn: "lib/eu-vat-collect.ts", recordedOn: "2027-01-20", registration: "IE OSS", evidence: "tests/eu-vat-collect-card.test.ts" }];
const SWITCH = {
  reviewed: true,
  seller: { legalName: "Synthetic Seller LLC", address: "1 Test Street, Wilmington, DE 19801, United States" },
  eu: { memberState: "IE", vatNumber: "EU372000019", effectiveFrom: "2027-01-01" },
  reviews: [{ jurisdiction: "EU", registration: "EU372000019", reviewedOn: "2027-01-15", reviewer: "owner" }],
};
const ON = { records: RECORDS, vatSwitch: SWITCH, now: NOW, rates: RATES };

// The creator answered that it is not an e-publication (unit 5a): without that answer, nothing collects.
const ESS: EuSupplyFields = { priceCents: 2900, file: null, link: "https://example.com/pack", keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null, publication: false };
const GOODS: EuSupplyFields = { ...ESS, link: null, shipping: { countries: ["DE"] } };
const evidence = (ip: string | null, billing: string | null) => {
  const headers = new Headers();
  if (ip) headers.set("x-vercel-ip-country", ip);
  const form = new URLSearchParams();
  if (billing) form.set("billing_country", billing);
  return { headers, form };
};

/** A built one-off body, as createCheckout leaves it after the share. */
const plainBody = (cents = 2900, fee: string | null = null) => {
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": "Pattern pack",
    "automatic_tax[enabled]": "true",
    "adaptive_pricing[enabled]": "false",
  });
  if (fee !== null) body.set("payment_intent_data[application_fee_amount]", fee);
  return body;
};
const tryCollect = (body: URLSearchParams, extra: Partial<Parameters<typeof applyEuCollect>[1]> = {}) => {
  try {
    applyEuCollect(body, { country: "DE", chooseYourPrice: false, buyerCurrencyLive: false, costsCents: () => 12, now: NOW, rates: RATES, ...extra });
    return "ok";
  } catch (error) {
    return error instanceof EuVatCollectRefused ? "refused" : `threw ${String(error)}`;
  }
};

const SHOP = "vatcollectshop";
const ask = (ip: string | null, fields: Record<string, string>) => {
  const form = withConsent(new FormData());
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const headers: Record<string, string> = { host: "marktmorgen.com" };
  if (ip) headers["x-vercel-ip-country"] = ip;
  return new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: form, headers });
};

async function main(): Promise<void> {
  part("Nothing collects today: the real values");
  is("no deemed-supplier record and the switch off", [DEEMED_SUPPLIER_RECORDS.length, EU_VAT_COLLECT_REVIEWED], [0, false]);
  is("no reviewed cost of receiving the VAT: unknown, never zero", euVatCollectionCostCents(551, "eur"), null);
  for (const [ip, billing] of [["US", "US"], ["DE", "DE"], ["FR", "FR"], ["GB", "GB"], ["US", "FR"], ["DE", null], [null, null], ["CA", "CA"]] as const) {
    const sent = evidence(ip, billing);
    const gate = euSaleGate({ product: ESS, ...sent });
    const base = consumerGate({ product: ESS, ...sent });
    is(`IP ${ip ?? "-"}, billing ${billing ?? "-"}: exactly consumerGate`, gate, base.ok ? { ok: true, collect: null } : base);
  }

  part("The route: the same checkout it opens today, and the same refusals");
  redis.clear();
  const owner = "vatcollect@example.com";
  await claimHandle(owner, SHOP, "VAT Collect Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestVatColl01", true);
  await setSubscription(owner, { customerId: "cus_VatCollect001", subscriptionId: "sub_VatCollect001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Pattern pack", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.com/pack");
  const id = made.product.id;
  const buy = (ip: string | null, fields: Record<string, string> = {}) => checkoutRoute(ask(ip, { handle: SHOP, product: id, ...fields }));
  const where = (response: Response) => [response.status, response.headers.get("location")];
  let before = sessions.length;
  is("an EU buyer: back with abroad, Stripe not asked", [...where(await buy("DE", { billing_country: "DE" })), sessions.length - before], [303, `https://marktmorgen.com/@${SHOP}/p/${id}?status=abroad#buy`, 0]);
  before = sessions.length;
  await buy("US", { billing_country: "US" });
  const sent = sessions.at(-1)!;
  is("a US buyer: Stripe's page opens once", sessions.length - before, 1);
  is("with no VAT line, no EU VAT mark and the creator's own tax as before", [sent.has("line_items[1][price_data][unit_amount]"), sent.has("payment_intent_data[metadata][eu_vat]"), sent.has("payment_intent_data[application_fee_amount]")], [false, false, false]);
  const route = readFileSync("app/api/store/checkout/route.ts", "utf8");
  is("the route hands createCheckout euVat only when its EU gate said to collect", /\.\.\.\(gate\.collect \? \{ euVat: \{ country: gate\.collect\.country \} \} : \{\}\)/.test(route), true);
  const checkout = readFileSync("lib/store-checkout.ts", "utf8");
  is("createCheckout touches the body for EU VAT only when it was handed euVat", (checkout.match(/applyEuCollect\(/g) ?? []).length === 1 && /if \(extras\.euVat\) applyEuCollect\(body,/.test(checkout), true);
  // The same product, the same buyer, through createCheckout with and without an empty euVat: the same body.
  const store = (await storeForEmail(owner))!;
  const product = (await readProduct(store, id))!;
  await createCheckout(store, product, "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT });
  const without = sessions.at(-1)!.toString().replace(/expires_at=\d+/, "");
  await createCheckout(store, product, "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT, euVat: undefined });
  is("createCheckout with euVat undefined sends the same body, byte for byte", sessions.at(-1)!.toString().replace(/expires_at=\d+/, ""), without);

  part("With a collect record and the switch on (injected here only)");
  is("a German buyer whose IP and billing agree: collected", euSaleGate({ product: ESS, ...evidence("DE", "DE"), ...ON }), { ok: true, collect: { country: "DE" } });
  // Unit 4 (Claude 2's note 1 on #4999): the table holds only the standard rate, and a Member State may tax an
  // e-publication at a reduced one, so only a product explicitly classified as not one is collected; never on a guess.
  const refusedDE = consumerGate({ product: ESS, ...evidence("DE", "DE") });
  is("the product not classified either way: refused as today", euSaleGate({ product: { ...ESS, publication: undefined }, ...evidence("DE", "DE"), ...ON }), refusedDE);
  is("an e-publication: refused as today, never the standard rate", euSaleGate({ product: { ...ESS, publication: true }, ...evidence("DE", "DE"), ...ON }), refusedDE);
  is("a cart whose products are not classified: refused as today", euCartGate({ products: [{ ...ESS, publication: undefined }, { ...ESS, publication: undefined }], ...evidence("DE", "DE"), ...ON }), refusedDE);
  is("a US buyer: goes on, nothing to collect", euSaleGate({ product: ESS, ...evidence("US", "US"), ...ON }), { ok: true, collect: null });
  for (const [label, ip, billing] of [["a UK buyer", "GB", "GB"], ["IP outside, billing in the EU", "US", "DE"], ["IP and billing in two EU countries", "DE", "FR"], ["no rate for that country", "FR", "FR"]] as const) {
    const sentNow = evidence(ip, billing);
    is(`${label}: refused as today`, euSaleGate({ product: ESS, ...sentNow, ...ON }), consumerGate({ product: ESS, ...sentNow }));
  }
  is("no billing country: asked for it, as today", euSaleGate({ product: ESS, ...evidence("DE", null), ...ON }).ok, false);
  is("goods to an EU buyer: refused (art. 14a is not built)", euSaleGate({ product: GOODS, ...evidence("DE", "DE"), ...ON }).ok, false);
  is("the switch half on (no owner review): refused as today", euSaleGate({ product: ESS, ...evidence("DE", "DE"), ...ON, vatSwitch: { ...SWITCH, reviews: [] } }).ok, false);
  is("a refuse-consumers record: refused as today", euSaleGate({ product: ESS, ...evidence("DE", "DE"), ...ON, records: [{ ...RECORDS[0], treatment: "refuse-consumers" }] }).ok, false);

  part("The VAT on top, through the fee, never out of the share");
  const body = plainBody(2900, "300");
  is("a plain one-off sale takes it", tryCollect(body), "ok");
  is("its own line: 19% of the line's real amount, named with the country and rate", [body.get("line_items[1][price_data][unit_amount]"), body.get("line_items[1][price_data][product_data][name]")], ["551", "VAT (Germany, 19%)"]);
  is("the fee is the share + the VAT + the cost of receiving it", body.get("payment_intent_data[application_fee_amount]"), String(300 + 551 + 12));
  is("the creator's own automatic tax is off for this sale", body.has("automatic_tax[enabled]"), false);
  is("the line's price is untouched: the VAT is on top", body.get("line_items[0][price_data][unit_amount]"), "2900");
  is("the sale carries its VAT mark", body.get("payment_intent_data[metadata][eu_vat]"), "DE:1900:551");
  const discounted = plainBody(1450);
  tryCollect(discounted);
  is("a sale price: the VAT is worked out on what is charged", discounted.get("line_items[1][price_data][unit_amount]"), String(Math.floor((1450 * 1900 + 5000) / 10000)));

  part("Every unknown refuses before Stripe, with the body untouched");
  const unknownCost = plainBody();
  const untouched = unknownCost.toString();
  is("RED → GREEN: no reviewed cost of receiving the VAT refuses (never collects with zero cost)", [tryCollect(unknownCost, { costsCents: undefined }), unknownCost.toString() === untouched], ["refused", true]);
  is("a cost that is not a whole number of cents refuses", tryCollect(plainBody(), { costsCents: () => 1.5 }), "refused");
  is("a negative cost refuses", tryCollect(plainBody(), { costsCents: () => -1 }), "refused");
  is("no sourced rate for the country refuses", tryCollect(plainBody(), { country: "FR" }), "refused");
  // The official table (lib/eu-vat-amount.ts EU_VAT_RATES) is valid until its review date; past it, nothing collects.
  is("the official rate table past its review date refuses", tryCollect(plainBody(), { rates: EU_VAT_RATES, now: new Date(`${Number(EU_VAT_RATES_VALID_UNTIL.slice(0, 4)) + 1}-01-02T00:00:00Z`) }), "refused");
  is("and within it, Germany's official rate collects", tryCollect(plainBody(), { rates: EU_VAT_RATES, now: new Date(`${EU_VAT_RATES_VALID_UNTIL}T00:00:00Z`) }), "ok");
  is("a country that is not two letters refuses", tryCollect(plainBody(), { country: "de" }), "refused");
  const variants: [string, (b: URLSearchParams) => void][] = [
    ["a second line (a box ticked)", (b) => b.set("line_items[1][price_data][unit_amount]", "500")],
    ["a quantity of two", (b) => b.set("line_items[0][quantity]", "2")],
    ["a Stripe Price instead of an amount", (b) => b.set("line_items[0][price]", "price_123")],
    ["a coupon", (b) => b.set("discounts[0][coupon]", "SPRING")],
    ["a promotion code from a link", (b) => b.set("discounts[0][promotion_code]", "promo_1")],
    ["Stripe's promotion box", (b) => b.set("allow_promotion_codes", "true")],
    ["a subscription", (b) => b.set("mode", "subscription")],
    ["shipping", (b) => b.set("shipping_address_collection[allowed_countries][0]", "DE")],
    ["Stripe's conversion on", (b) => b.set("adaptive_pricing[enabled]", "true")],
    ["no amount on the line", (b) => b.delete("line_items[0][price_data][unit_amount]")],
  ];
  for (const [label, change] of variants) {
    const b = plainBody();
    change(b);
    const was = b.toString();
    is(`${label}: refused, body untouched`, [tryCollect(b), b.toString() === was], ["refused", true]);
  }
  is("a price the buyer chooses: refused", tryCollect(plainBody(), { chooseYourPrice: true }), "refused");
  is("the buyer's currency conversion live: refused", tryCollect(plainBody(), { buyerCurrencyLive: true }), "refused");

  part("End to end through createCheckout, with the Stripe stand-in");
  before = sessions.length;
  const refused = await createCheckout(store, product, "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT, euVat: { country: "DE", now: NOW, rates: RATES } }).then(() => "opened", (error: unknown) => (error instanceof EuVatCollectRefused ? "refused" : String(error)));
  is("handed euVat with no reviewed cost: refused, Stripe never asked", [refused, sessions.length - before], ["refused", 0]);
  before = sessions.length;
  await createCheckout(store, product, "https://marktmorgen.com", undefined, { digitalConsent: TEST_CONSENT, euVat: { country: "DE", now: NOW, rates: RATES, costsCents: () => 12 } });
  const collected = sessions.at(-1)!;
  is("handed euVat with a cost: Stripe asked once", sessions.length - before, 1);
  is("the request carries the VAT line on top of the product's own amount", [collected.get("line_items[0][price_data][unit_amount]"), collected.get("line_items[1][price_data][unit_amount]")], ["2900", "551"]);
  is("and the fee of the VAT and its cost (the plan's share is 0% today)", collected.get("payment_intent_data[application_fee_amount]"), String(551 + 12));
  is("and no automatic tax from the creator's account", collected.has("automatic_tax[enabled]"), false);

  part("A sale refused for its EU VAT holds nothing (Claude 5's LOW on #4975)");
  // The route names EuVatCollectRefused among the refusals before Stripe: the unit comes back at once, and so does the
  // per-address hold count. The real values never hand createCheckout euVat, so the route cannot be driven into it
  // here; the source is pinned and withStockHold is shown giving the unit back for that refusal.
  is("withStockHold's refusal names it", /\(error\) => refusedBeforeStripe\(error\) \|\| error instanceof ReturningCodeRefused \|\| error instanceof EuVatCollectRefused,/.test(route), true);
  is("and so does the hold count given back in the catch", /if \(charged && \([^)]*error instanceof EuVatCollectRefused\)\) await giveBackHold\(/.test(route), true);
  const limited = await setProductExtras(owner, id, { stock: 1 });
  if (!limited.ok) throw new Error(`stock fixture: ${limited.reason}`);
  const now = (await storeForEmail(owner))!;
  const listing = (await readListing(now, id))!;
  is("a limited product: one unit left", await stockLeft(now, listing), 1);
  const refusal = (error: unknown) => refusedBeforeStripe(error) || error instanceof EuVatCollectRefused;
  const held = await withStockHold(now, listing, async () => {
    throw new EuVatCollectRefused("the cost of receiving the VAT is unknown");
  }, refusal).then((value) => value, (error: unknown) => (error instanceof EuVatCollectRefused ? "rethrown" : String(error)));
  is("the refusal goes on to the route's catch", held, "rethrown");
  is("and the unit is back at once", await stockLeft(now, (await readListing(now, id))!), 1);

  part("An EU sale is declared in euros: one charged in pounds is refused, by the real cost of receiving the VAT (coord 79fb's LEVE 2)");
  {
    // The real cost function, with a reviewed-looking allowance for the euro and for the pound but none of the pound
    // against the euro: the EU path asks the euro as the return currency, so the gap of a pound sale has no allowance.
    const allowance = (currency: string) => ({ currency, bps: 200, source: "https://example.invalid/fx", checkedOn: "2027-01-01", validThrough: "2027-12-31" });
    const realCost = (vatCents: number, currency: string, back?: string) => vatCollectionCostOf(vatCents, currency, [allowance("eur"), allowance("gbp")], NOW, back)?.feeCents ?? null;
    const inPounds = plainBody();
    inPounds.set("line_items[0][price_data][currency]", "gbp");
    is("an EU sale in euros is charged with the real cost", tryCollect(plainBody(), { costsCents: realCost }), "ok");
    is("RED → GREEN: an EU sale in pounds is refused (no allowance of the pound against the euro)", tryCollect(inPounds, { costsCents: realCost }), "refused");
    is("the EU return currency is the euro", OSS_RETURN_CURRENCY, "eur");
    // A Member State of identification outside the euro area may require its own currency (art. 365): adding one must
    // revisit OSS_RETURN_CURRENCY, so this list is held as it stands (coord 79fb's LEVE 3).
    is("the accepted Member States of identification are the ones whose return is in euros", Object.keys(OSS_IDENTIFICATION_CODES), ["IE"]);
    // The comments say what the code does (coord 79fb's LEVEs 1 and 5): no "only euros and pounds", and the citation
    // names art. 365 (the return in euro) and art. 366 (the ECB rate on the last day of the period).
    const source = readFileSync(join(process.cwd(), "lib/eu-vat-collect.ts"), "utf8") + readFileSync(join(process.cwd(), "tests/vat-fee-words.test.ts"), "utf8");
    is("no comment says the EU side reads euros and pounds", /only euros and pounds/.test(source), false);
    is("the citation names arts. 365 and 366", /art\. 365[\s\S]{0,400}art\. 366/.test(readFileSync(join(process.cwd(), "lib/eu-vat-collect.ts"), "utf8")), true);
  }

  done();
}

void main();
