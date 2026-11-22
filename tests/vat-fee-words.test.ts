/**
 * 793 [IV3] unit 2, item (a) (OWNER-20261121-1529-ART9A-PENDING-DECISIONS, item 2; OWNER-20261122-0022, option A):
 * what the Terms and the pricing page tell a creator about the VAT Marktmorgen collects as the deemed supplier, with a
 * worked example in figures, from lib/vat-fee-words.ts.
 *
 *   - Shown only while that VAT is really collected (vatCollecting, the checkout's own condition: the deemed-supplier
 *     record says "collect" and the whole switch is on) and its costs are known: today,
 *     with both switches off, nothing is shown (AGENTS.md VR, item 2).
 *   - The example is worked out by the code that charges (vatOnTop, ukVatOnTop, vatCollectionCostOf), never typed.
 *   - The words keep the owner's rule: the VAT on top of the price, the real costs of receiving it in the platform's fee
 *     with no profit, Stripe's fee on the VAT part paid by the creator, no card surcharge to the buyer, and no share of
 *     tax ever taken.
 *   - Short sentences in plain US English (AX274, 3.1.5), and no other file types them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLE_PROCESSING_BPS, termsLastUpdated, vatCanTurnOn, vatFeeWords } from "@/lib/vat-fee-words";
import { vatOnTop } from "@/lib/eu-vat-amount";
import { ukVatOnTop } from "@/lib/uk-vat";
import { REVIEWED_VAT_FX_ALLOWANCES, vatCollectionCostOf, type VatFxAllowance } from "@/lib/eu-vat-collection-cost";
import type { SwitchInput } from "@/lib/vat-registrations";
import { dynamicPolicy, isDynamicPage, staticPolicy } from "@/lib/csp";
import { VAT_BODY_REFUSALS, VAT_REFUSED_PLACE_NAMES, VAT_REFUSED_SALES, VAT_SUPPLY_WORDS } from "@/lib/vat-fee-words";
import { EU_VAT_COUNTRIES, REFUSED_PLACES, TERRITORY_UNSETTLED } from "@/lib/eu-vat-supply";
import { consumerGate } from "@/lib/eu-vat-gate";
import { euSupplyOf } from "@/lib/eu-vat-supply";
import { applyEuCollect, euCartGate, euSaleGate } from "@/lib/eu-vat-collect";
import type { EuSupplyFields } from "@/lib/eu-vat-supply";

const NOW = new Date("2026-11-22T12:00:00Z");
const ALLOWANCES: VatFxAllowance[] = [
  { currency: "eur", bps: 200, source: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/", checkedOn: "2026-11-01", validThrough: "2026-12-31" },
  { currency: "gbp", bps: 200, source: "https://www.bankofengland.co.uk/statistics", checkedOn: "2026-11-01", validThrough: "2026-12-31" },
];
const SELLER = { legalName: "Synthetic Seller LLC", address: "1 Synthetic Street, Testville" };
const EU_ON: SwitchInput = {
  reviewed: true, seller: SELLER, now: NOW,
  eu: { memberState: "IE", vatNumber: "EU372000000", effectiveFrom: "2026-11-01" },
  reviews: [{ jurisdiction: "EU", registration: "EU372000000", reviewedOn: "2026-11-02", reviewer: "owner" }],
};
const UK_ON: SwitchInput = {
  reviewed: true, seller: SELLER, now: NOW,
  uk: { vatNumber: "123456789", effectiveFrom: "2026-11-01" },
  reviews: [{ jurisdiction: "UK", registration: "123456789", reviewedOn: "2026-11-02", reviewer: "owner" }],
};
const OFF: SwitchInput = { reviewed: false, now: NOW };
const RECORD = { treatment: "collect", implementedIn: "lib/eu-vat-collect.ts", recordedOn: "2026-11-02", evidence: "tests/vat-fee-words.test.ts" };
/** The deemed-supplier records the checkout collects on (lib/deemed-supplier.ts): both places say "collect". */
/** A product the checkout charges VAT on: a link, answered not an e-publication (lib/eu-vat-collect.ts notAPublication). */
const ESS: EuSupplyFields = { priceCents: 2900, file: null, link: "https://example.com/pack", keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null, publication: false };
const RATES = [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-02" }, { country: "FR", basisPoints: 2000, source: "https://example.invalid/fr", readOn: "2026-11-02" }];
const COLLECT = [{ ...RECORD, jurisdiction: "EU", registration: "IE OSS" }, { ...RECORD, jurisdiction: "UK", registration: "UK VAT 123456789" }];

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
const halfUp = (cents: number, bps: number) => Math.floor((cents * bps + 5_000) / 10_000);
const all = (words: NonNullable<ReturnType<typeof vatFeeWords>>) => [...words.terms, ...words.pricing, ...words.example].join(" ");

test("today nothing is shown: both switches are off", () => {
  assert.equal(vatFeeWords(), null);
  assert.equal(vatFeeWords({ records: COLLECT, eu: OFF, uk: OFF, now: NOW, allowances: ALLOWANCES }), null);
});

test("a switch on but an unknown cost of receiving the VAT shows nothing, never a zero cost", () => {
  assert.equal(vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: [] }), null);
});

test("the EU example is worked out by the code that charges", () => {
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: OFF, now: NOW, allowances: ALLOWANCES });
  assert.ok(words);
  assert.deepEqual(words.places, ["EU"]);
  const vat = vatOnTop(10_000, "DE", undefined, NOW);
  assert.ok(vat);
  const cost = vatCollectionCostOf(vat.vatCents, "eur", ALLOWANCES, NOW);
  assert.ok(cost);
  assert.deepEqual(words.figures, {
    country: "DE", currency: "eur", priceCents: 10_000, basisPoints: vat.basisPoints, vatCents: vat.vatCents,
    totalCents: vat.totalCents, costCents: cost.feeCents, feeCents: vat.vatCents + cost.feeCents,
    stripePartCents: halfUp(vat.vatCents, EXAMPLE_PROCESSING_BPS),
  });
  const text = all(words);
  for (const cents of [10_000, vat.vatCents, vat.totalCents, cost.feeCents, vat.vatCents + cost.feeCents, halfUp(vat.vatCents, EXAMPLE_PROCESSING_BPS)]) {
    assert.ok(text.includes(money(cents, "eur")), `${money(cents, "eur")} is in the example`);
  }
  assert.match(text, /European Union/);
  assert.doesNotMatch(text, /United Kingdom/);
});

test("with only the UK on, the example is in pounds at the UK rate", () => {
  const words = vatFeeWords({ records: COLLECT, eu: OFF, uk: UK_ON, now: NOW, allowances: ALLOWANCES });
  assert.ok(words);
  assert.deepEqual(words.places, ["UK"]);
  const vat = ukVatOnTop(10_000);
  assert.ok(vat);
  const cost = vatCollectionCostOf(vat.vatCents, "gbp", ALLOWANCES, NOW);
  assert.ok(cost);
  assert.equal(words.figures.currency, "gbp");
  assert.equal(words.figures.feeCents, vat.vatCents + cost.feeCents);
  const text = all(words);
  for (const cents of [10_000, vat.vatCents, vat.totalCents, vat.vatCents + cost.feeCents]) {
    assert.ok(text.includes(money(cents, "gbp")), `${money(cents, "gbp")} is in the example`);
  }
  assert.match(text, /United Kingdom/);
  assert.doesNotMatch(text, /European Union/);
});

test("both on: both places are named, the example stays in euros", () => {
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES });
  assert.ok(words);
  assert.deepEqual(words.places, ["EU", "UK"]);
  assert.equal(words.figures.currency, "eur");
  assert.match(all(words), /European Union and the United Kingdom/);
});

test("the words keep the owner's rule, item 2 (a) to (d), option A", () => {
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES });
  assert.ok(words);
  for (const part of [words.terms, words.pricing]) {
    const text = part.join(" ");
    assert.match(text, /on top of your price/, "the VAT is added on top of the price");
    assert.match(text, /no profit/, "the costs of receiving it carry no profit");
    assert.match(text, /Stripe/, "Stripe's fee on the VAT part is named");
    assert.match(text, /you pay/, "the creator pays that part");
    assert.match(text, /never pays a card surcharge/, "never a surcharge to the buyer");
    assert.match(text, /never take a share of tax/, "no share of tax");
  }
  assert.match(all(words), new RegExp(`${EXAMPLE_PROCESSING_BPS / 100}% rate`), "the example's Stripe rate is named as an example");
});

test("the scope is what the code collects for: products delivered automatically online, never live calls or goods (Claude 1's MEDIUM)", () => {
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES });
  assert.ok(words);
  for (const part of [words.terms, words.pricing]) {
    const text = part.join(" ");
    assert.doesNotMatch(text, /digital product/i, "never the wider \"digital product\", which a creator reads as including a live call");
    assert.match(text, /delivered automatically online/, "the scope of lib/eu-vat-supply.ts \"ess\"");
    assert.match(text, /Live calls are not covered/, "the \"human\" supply is named as outside it");
    assert.ok(words.refused.includes("Products that ship"), "the \"goods\" supply is named among the refused sales (f9afa7's LEVE)");
  }
});

test("pages and checkout read the same decision: with both reviewed constants off no clock turns the words on, otherwise the pages render per request (Claude 1 f9afa7's MEDIUM)", () => {
  assert.equal(vatCanTurnOn(), false, "today both EU_VAT_COLLECT_REVIEWED and UK_VAT_COLLECT_REVIEWED are false");
  // With the constants off, every date and every clock leaves the words off, so a page built ahead of time is right.
  for (const day of ["2026-11-01", "2026-12-31", "2027-06-30", "2030-01-01"]) {
    const now = new Date(`${day}T12:00:00Z`);
    const off = { ...EU_ON, reviewed: false, now };
    assert.equal(vatFeeWords({ records: COLLECT, eu: off, uk: { ...UK_ON, reviewed: false, now }, now, allowances: ALLOWANCES }), null, `off on ${day}`);
  }
  for (const page of ["app/terms/page.tsx", "app/pricing/page.tsx"]) {
    const source = readFileSync(join(process.cwd(), page), "utf8");
    assert.match(source, /\{vatCanTurnOn\(\) \? <PerRequest \/> : null\}/, `${page} renders per request once a switch can turn on`);
    assert.match(source, /from "@\/components\/per-request"/, `${page} uses the one per-request marker`);
  }
  const marker = readFileSync(join(process.cwd(), "components/per-request.tsx"), "utf8");
  assert.match(marker, /await connection\(\);/, "the marker waits for the request (next/server connection)");
});

test("the nonce policy follows the same decision: /terms and /pricing are per-request pages exactly when vatCanTurnOn() (Claude 1 E's LEVE)", () => {
  for (const path of ["/terms", "/pricing"]) {
    assert.equal(isDynamicPage(path), vatCanTurnOn(), `${path}: the proxy's nonce decision is the pages' per-request decision`);
    assert.equal(isDynamicPage(path, true), true, `${path} gets the nonce policy once a switch can turn on`);
    assert.equal(isDynamicPage(path, false), false, `${path} keeps the static policy while it is built ahead of time`);
  }
  for (const path of ["/terms-of-sale", "/pricing/compare", "/help"]) assert.equal(isDynamicPage(path, true), false, `${path} is not one of the two pages`);
  assert.equal(isDynamicPage("/studio", false), true, "the pages that were per request stay so");
});

test("only allowances the cost code accepts date the words; a malformed one never throws (Claude 1 f9afa7's LEVE)", () => {
  const later: SwitchInput = { ...EU_ON, reviews: [{ jurisdiction: "EU", registration: "EU372000000", reviewedOn: "2026-11-02", reviewer: "owner" }] };
  const malformed = [...ALLOWANCES, { currency: "eur", bps: 300, source: "https://www.ecb.europa.eu/", checkedOn: "2026-11-1a", validThrough: "2026-12-31" }];
  const a = vatFeeWords({ records: COLLECT, eu: later, uk: OFF, now: NOW, allowances: malformed });
  assert.ok(a);
  assert.equal(a.since, "2026-11-02", "the malformed day is not read");
  assert.doesNotThrow(() => termsLastUpdated("2026-11-10", a));
  const plainHttp = [...ALLOWANCES, { currency: "eur", bps: 300, source: "http://www.ecb.europa.eu/", checkedOn: "2026-11-20", validThrough: "2026-12-31" }];
  assert.equal(vatFeeWords({ records: COLLECT, eu: later, uk: OFF, now: NOW, allowances: plainHttp })?.since, "2026-11-02", "an allowance the cost code refuses does not move the date");
});

test("short sentences in plain US English", () => {
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES });
  assert.ok(words);
  for (const sentence of all(words).split(/(?<=[.:])\s+/)) {
    assert.ok(sentence.split(/\s+/).length <= 30, `"${sentence}" has at most 30 words`);
  }
  assert.doesNotMatch(all(words), /\b(deemed|aforementioned|hereinafter|pursuant)\b/i);
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("the words carry the first day they can show: the latest of the registration, the owner's review and the allowance", () => {
  const later: SwitchInput = { ...EU_ON, reviews: [{ jurisdiction: "EU", registration: "EU372000000", reviewedOn: "2026-11-20", reviewer: "owner" }] };
  const words = vatFeeWords({ records: COLLECT, eu: later, uk: OFF, now: NOW, allowances: ALLOWANCES });
  assert.ok(words);
  assert.equal(words.since, "2026-11-20");
  const lateAllowance = ALLOWANCES.map((a) => ({ ...a, checkedOn: "2026-11-21" }));
  assert.equal(vatFeeWords({ records: COLLECT, eu: later, uk: OFF, now: NOW, allowances: lateAllowance })?.since, "2026-11-21");
  // One day earlier the words are not shown at all, so the Terms' date is never earlier than the text.
  const dayBefore = new Date("2026-11-19T12:00:00Z");
  assert.equal(vatFeeWords({ records: COLLECT, eu: { ...later, now: dayBefore }, uk: OFF, now: dayBefore, allowances: ALLOWANCES }), null);
  const both = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: { ...UK_ON, reviews: [{ jurisdiction: "UK", registration: "123456789", reviewedOn: "2026-11-18", reviewer: "owner" }] }, now: NOW, allowances: ALLOWANCES });
  assert.equal(both?.since, "2026-11-18", "with both on, the later place's dates count");
});

test("the Terms' Last updated date moves with the VAT paragraph, never earlier than its first day (section 15)", () => {
  assert.equal(termsLastUpdated("2026-11-10", null), "November 10, 2026");
  const words = vatFeeWords({ records: COLLECT, eu: { ...EU_ON, reviews: [{ jurisdiction: "EU", registration: "EU372000000", reviewedOn: "2026-11-20", reviewer: "owner" }] }, uk: OFF, now: NOW, allowances: ALLOWANCES });
  assert.ok(words);
  assert.equal(termsLastUpdated("2026-11-10", words), "November 20, 2026");
  assert.equal(termsLastUpdated("2026-11-25", words), "November 25, 2026", "a later Terms change keeps its own date");
  assert.throws(() => termsLastUpdated("2026-02-30", null), "an impossible base date is refused, never printed");
  const page = readFileSync(join(process.cwd(), "app/terms/page.tsx"), "utf8");
  assert.match(page, /lastUpdated=\{termsLastUpdated\(TERMS_UPDATED_ON, vat\)\}/, "the Terms page dates itself through termsLastUpdated");
  assert.doesNotMatch(page, /lastUpdated="/, "no typed Last updated date on the Terms page");
});

test("the Terms and the pricing page show these words, and only while vatFeeWords gives them", () => {
  for (const page of ["app/terms/page.tsx", "app/pricing/page.tsx"]) {
    const source = readFileSync(join(process.cwd(), page), "utf8");
    assert.match(source, /from "@\/lib\/vat-fee-words"/, `${page} reads lib/vat-fee-words.ts`);
    assert.match(source, /const vat = vatFeeWords\(\);/, `${page} asks for the words once`);
    assert.match(source, /\{vat \? \(/, `${page} shows them only when there are words`);
  }
  const typed = ["app", "components", "lib"]
    .flatMap((dir) => files(join(process.cwd(), dir)))
    .filter((path) => !path.endsWith(join("lib", "vat-fee-words.ts")))
    .filter((path) => /never take a share of tax|We add no profit/.test(readFileSync(path, "utf8")));
  assert.deepEqual(typed, []);
});

test("the words show on the checkout's own condition: a switch on with a record that does not say collect shows nothing (MEDIUM 1)", () => {
  const refusing = COLLECT.map((r) => ({ ...r, treatment: "refuse-consumers" }));
  assert.equal(vatFeeWords({ records: refusing, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES }), null, "both switches on, no record says collect");
  const euOnly = [COLLECT[0], { ...COLLECT[1], treatment: "refuse-consumers" }];
  assert.deepEqual(vatFeeWords({ records: euOnly, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })?.places, ["EU"], "only the place that collects");
  assert.equal(vatFeeWords({ eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES }), null, "today's DEEMED_SUPPLIER_RECORDS collect nowhere");
  // The checkout reads the same records: with the refusing ones it collects nothing for a German buyer either.
  const headers = new Headers({ "x-vercel-ip-country": "DE" });
  const form = new URLSearchParams({ billing_country: "DE" });
  // A product the checkout really charges VAT on (a link, answered not an e-publication): with "collect" it collects,
  // with "refuse-consumers" it is refused, so the assertion is about the records and nothing else (coord fb70's LEVE).
  const collects = euSaleGate({ product: ESS, headers, form, records: COLLECT, vatSwitch: EU_ON, now: NOW, rates: RATES });
  assert.deepEqual(collects, { ok: true, collect: { country: "DE" } }, "with collect records the same product is charged VAT");
  const gate = euSaleGate({ product: ESS, headers, form, records: refusing, vatSwitch: EU_ON, now: NOW, rates: RATES });
  assert.equal(gate.ok, false, "the checkout does not collect where the words would not show: it refuses");
});

test("the words name every sale the checkout refuses, each beside the check that refuses it (MEDIUM 2)", () => {
  const code = readFileSync(join(process.cwd(), "lib/eu-vat-collect.ts"), "utf8");
  for (const r of VAT_REFUSED_SALES) for (const check of r.checks) assert.ok(code.includes(check), `lib/eu-vat-collect.ts still refuses: ${check}`);
  // And the other way: every refusal the checkout's body check makes is named in the words, or is one our own code
  // builds and no creator's choice can cause (VAT_BODY_REFUSALS), so no sale is refused that the Terms do not name (LEVE 1).
  const refusals = new Set([...code.matchAll(/refuse\("([^"]+)"\)/g)].map((m) => m[1]));
  const named = new Set<string>([...VAT_REFUSED_SALES.flatMap((r): readonly string[] => r.checks), ...VAT_BODY_REFUSALS.map((r) => r.check)]);
  for (const refusal of refusals) assert.ok(named.has(refusal), `named in VAT_REFUSED_SALES or VAT_BODY_REFUSALS: ${refusal}`);
  assert.ok(refusals.has("not a one-off payment"));
  assert.ok(VAT_REFUSED_SALES.some((r) => r.words.includes("Payment plans") && (r.checks as readonly string[]).includes("not a one-off payment")), "payment plans are named");
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })!;
  for (const part of [words.terms, words.pricing]) {
    const text = part.join(" ");
    assert.ok(!/membership's content/.test(text), "a subscription is never promised");
    assert.doesNotMatch(text, /It refuses/, "the refusals are a list, not sentences (AX274 3.1.5)");
  }
  assert.deepEqual(words.refused, VAT_REFUSED_SALES.map((r) => r.words), "every refusal is an item of the list on both pages");
  for (const page of ["app/terms/page.tsx", "app/pricing/page.tsx"]) {
    const source = readFileSync(join(process.cwd(), page), "utf8");
    assert.match(source, /vat\.refused\.map\(\(item\) => <li key=\{item\}>/, `${page} shows the list`);
    assert.match(source, /vat\.refusedPlaces\.map\(\(place\) => <li key=\{place\}>/, `${page} shows each place on its own line (2as's LEVE)`);
  }
  assert.ok(words.refused.some((w) => /e-publications, which are books, newspapers or magazines read on a screen/.test(w)), "e-publication is explained where it is used (3.1.3)");
  assert.ok(words.refused.some((w) => /not yet marked, on the product, as not an e-publication/.test(w)), "the creator's answer is asked for");
  // Each one really is refused by the checkout's body check.
  const body = (extra: Record<string, string>) => new URLSearchParams({ mode: "payment", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "eur", "line_items[0][price_data][unit_amount]": "10000", "adaptive_pricing[enabled]": "false", ...extra });
  const input = { country: "DE", chooseYourPrice: false, buyerCurrencyLive: false, now: NOW, costsCents: () => 10 };
  assert.throws(() => applyEuCollect(body({ "subscription_data[metadata][x]": "1" }), input), /subscription/);
  assert.throws(() => applyEuCollect(body({}), { ...input, chooseYourPrice: true }), /price the buyer chooses/);
  assert.throws(() => applyEuCollect(body({ allow_promotion_codes: "true" }), input), /promotion/);
  assert.throws(() => applyEuCollect(body({}), { ...input, buyerCurrencyLive: true }), /buyer's currency/);
  assert.throws(() => applyEuCollect(body({ "line_items[0][quantity]": "2" }), input), /quantity/);
  assert.throws(() => applyEuCollect(body({}), { ...input, costsCents: () => null }), /cost of receiving the VAT is unknown/);
});

test("US English: the tax authority, no 'pay it over', no 'tax office', no 'the payment itself' (LEVEs)", () => {
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })!;
  const text = [words.title, ...words.terms, ...words.pricing, ...words.example].join(" ");
  assert.doesNotMatch(text, /pay it over|tax office|payment itself|nothing is charged and/);
  assert.match(words.refusedLead.terms, /does not accept these sales from a consumer in .*; nothing is charged for them:/);
  assert.match(text, /tax authority/);
});

test("per request, /terms and /pricing reach only the site itself, as their page built ahead of time does (LEVE)", () => {
  const directive = (policy: string, name: string) => policy.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  const plain = dynamicPolicy("bm9uY2U=", { store: false, selfOnly: true });
  assert.equal(directive(plain, "connect-src"), "connect-src 'self'");
  assert.equal(directive(plain, "frame-src"), "frame-src 'self'");
  assert.equal(directive(staticPolicy(), "connect-src"), "connect-src 'self'");
  const proxy = readFileSync(join(process.cwd(), "proxy.ts"), "utf8");
  assert.match(proxy, /selfOnly: isVatWordsPage\(path\)/, "the proxy gives the two pages that policy");
});

test("lib/vat-registrations.ts says what it imports (NIT)", () => {
  const head = readFileSync(join(process.cwd(), "lib/vat-registrations.ts"), "utf8").split("*/")[0];
  assert.doesNotMatch(head, /Imports nothing/);
  assert.match(head, /lib\/deemed-supplier\.ts/);
  // next.config.ts reaches it through lib/csp.ts and resolves no "@/" (the build of bd88c46869 failed on it).
  for (const file of ["lib/vat-registrations.ts", "lib/deemed-supplier.ts", "lib/csp.ts"]) {
    assert.doesNotMatch(readFileSync(join(process.cwd(), file), "utf8"), /^import [^;]*from "@\//m, `${file} imports by a relative path`);
  }
});

test("every route and gate that refuses an EU or UK consumer is named: PayPal, the offer after paying, tips, a bundle in a cart (coord 44dd's MEDIUM, fb70)", () => {
  // Every file that asks consumerGate itself (not through euSaleGate or euCartGate) refuses an EU or UK consumer
  // whatever the switch: each must be named by a VAT_REFUSED_SALES entry, which names it in the words.
  const callers = ["app", "components", "lib"].flatMap((dir) => files(join(process.cwd(), dir)))
    .filter((path) => readFileSync(path, "utf8").includes("consumerGate("))
    .map((path) => path.slice(process.cwd().length + 1))
    .filter((path) => path !== "lib/eu-vat-gate.ts" && path !== "lib/eu-vat-collect.ts")
    .sort();
  const named = new Set(VAT_REFUSED_SALES.flatMap((r) => r.files ?? []));
  for (const caller of callers) assert.ok(named.has(caller), `named in VAT_REFUSED_SALES: ${caller}`);
  for (const file of named) assert.ok(readFileSync(join(process.cwd(), file), "utf8").includes("consumerGate("), `${file} still refuses through consumerGate`);
  assert.ok(callers.includes("app/api/store/paypal/checkout/route.ts") && callers.includes("lib/upsell.ts"));
  // A bundle in a cart is refused even when the same bundle alone is charged VAT.
  const headers = new Headers({ "x-vercel-ip-country": "DE" });
  const form = new URLSearchParams({ billing_country: "DE" });
  const bundle = { ...ESS, bundle: ["member"] };
  const members = new Map([["member", ESS]]);
  assert.deepEqual(euSaleGate({ product: bundle, members, headers, form, records: COLLECT, vatSwitch: EU_ON, now: NOW, rates: RATES }), { ok: true, collect: { country: "DE" } }, "alone, the bundle is charged");
  assert.equal(euCartGate({ products: [bundle], headers, form, records: COLLECT, vatSwitch: EU_ON, now: NOW, rates: RATES }).ok, false, "in a cart, it is refused");
  const listed = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })!.refused;
  assert.ok(listed.includes("A bundle in a cart"), "and the list names it (coord 0cb1's LEVE 1)");
  // Evidence that disagrees (internet address in Germany, billing address in France) is refused, never charged on a guess.
  const split = euSaleGate({ product: ESS, headers, form: new URLSearchParams({ billing_country: "FR" }), records: COLLECT, vatSwitch: EU_ON, now: NOW, rates: RATES });
  assert.equal(split.ok, false);
  assert.ok(listed.some((w) => /internet address or billing address shows no country, or the two show different countries/.test(w)), "and the list names it");
  // A product with no answer on whether it is an e-publication is refused.
  assert.equal(euSaleGate({ product: { ...ESS, publication: null } as never, headers, form, records: COLLECT, vatSwitch: EU_ON, now: NOW, rates: RATES }).ok, false);
  assert.ok(listed.some((w) => /not yet marked, on the product, as not an e-publication/.test(w)), "and the list names it");
});


test("every kind of supply the gate refuses to an EU or UK consumer is named; products that ship among them (f9afa7's LEVE)", () => {
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })!;
  const headers = new Headers({ "x-vercel-ip-country": "DE" });
  const form = new URLSearchParams({ billing_country: "DE" });
  const kinds: Record<keyof typeof VAT_SUPPLY_WORDS, EuSupplyFields> = {
    ess: ESS,
    human: { ...ESS, link: null, call: { minutes: 30 } } as never,
    free: { ...ESS, priceCents: 0 },
    goods: { ...ESS, link: null, shipping: { countries: ["DE"] } } as never,
    unknown: { ...ESS, link: null },
  };
  for (const [kind, product] of Object.entries(kinds) as [keyof typeof VAT_SUPPLY_WORDS, EuSupplyFields][]) {
    assert.equal(euSupplyOf(product), kind, `the sample is a ${kind} supply`);
    const refused = !consumerGate({ product, headers, form }).ok;
    const said = VAT_SUPPLY_WORDS[kind];
    if (!refused) assert.equal(said, "outside", `${kind}: sold as before, said to be outside the section`);
    else if (said === "covered") assert.deepEqual(euSaleGate({ product, headers, form, records: COLLECT, vatSwitch: EU_ON, now: NOW, rates: RATES }), { ok: true, collect: { country: "DE" } }, `${kind}: covered means charged`);
    else assert.ok(words.refused.includes(said), `${kind}: refused, so named in the list: ${said}`);
  }
  const text = [...words.terms, ...words.pricing].join(" ");
  assert.doesNotMatch(text, /anything that ships are not covered/, "goods are never said to be merely outside the section");
});

test("every place the checkout refuses while it collects is named, and no place it charges is (coord 0cb1's MEDIUM)", () => {
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })!;
  assert.ok(words.refused.includes("Buyers in these places"), "one item leads the places");
  const placesItem = words.refusedPlaces.join("\n");
  const both: SwitchInput = { ...EU_ON, uk: UK_ON.uk, reviews: [...(EU_ON.reviews ?? []), ...(UK_ON.reviews ?? [])] };
  const allRates = [...EU_VAT_COUNTRIES].map((country) => ({ country, basisPoints: 2000, source: `https://example.invalid/${country.toLowerCase()}`, readOn: "2026-11-02" }));
  const places = [...new Set([...REFUSED_PLACES, ...TERRITORY_UNSETTLED])].sort();
  const charged: string[] = [];
  for (const place of places) {
    const gate = euSaleGate({ product: ESS, headers: new Headers({ "x-vercel-ip-country": place }), form: new URLSearchParams({ billing_country: place }), records: COLLECT, vatSwitch: both, now: NOW, rates: allRates });
    const name = VAT_REFUSED_PLACE_NAMES[place];
    if (gate.ok && gate.collect?.country === place) {
      charged.push(place);
      assert.equal(name, undefined, `${place} is charged VAT, so it is never named as refused`);
    } else {
      assert.equal(gate.ok, false, `${place}: refused, not sold without VAT`);
      assert.ok(name, `${place} is refused, so VAT_REFUSED_PLACE_NAMES names it`);
      assert.ok(placesItem.includes(name), `the list names ${name}`);
    }
  }
  for (const [code, name] of Object.entries(VAT_REFUSED_PLACE_NAMES)) assert.ok(places.includes(code) && !charged.includes(code), `${name} (${code}) is named only while it is refused`);
  for (const place of ["DE", "FR", "IT", "PT", "GB"]) assert.ok(charged.includes(place), `${place} is charged`);
});

test("one table: each sale a gate refuses while it collects, with the item of the list that names it (coord f49f)", () => {
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })!;
  const both: SwitchInput = { ...EU_ON, uk: UK_ON.uk, reviews: [...(EU_ON.reviews ?? []), ...(UK_ON.reviews ?? [])] };
  const at = (ip: string | null, billing: string | null) => {
    const headers = new Headers();
    if (ip) headers.set("x-vercel-ip-country", ip);
    return { headers, form: new URLSearchParams(billing ? { billing_country: billing } : {}) };
  };
  const call = { ...ESS, link: null, call: { minutes: 30 } } as never as EuSupplyFields;
  const sale = (product: EuSupplyFields, ip: string | null, billing: string | null, members?: ReadonlyMap<string, EuSupplyFields>) =>
    euSaleGate({ product, members, ...at(ip, billing), records: COLLECT, vatSwitch: both, now: NOW, rates: RATES });
  const mixed = { ...ESS, bundle: ["link", "call"] };
  const mixedMembers = new Map([["link", ESS], ["call", call]]);
  const rows: { case: string; refused: () => boolean; item: RegExp }[] = [
    { case: "a bundle of a live call and a link, to France", refused: () => !sale(mixed, "FR", "FR", mixedMembers).ok, item: /combines a live call with something delivered online/ },
    { case: "a bundle of a live call and a link, to the UK", refused: () => !sale(mixed, "GB", "GB", mixedMembers).ok, item: /combines a live call with something delivered online/ },
    { case: "no country from the internet address, billing in Germany", refused: () => !sale(ESS, null, "DE").ok, item: /billing address shows no country/ },
    { case: "internet address in Germany, no billing country", refused: () => !sale(ESS, "DE", null).ok, item: /billing address shows no country/ },
    { case: "internet address in Germany, billing in France", refused: () => !sale(ESS, "DE", "FR").ok, item: /the two show different countries/ },
    { case: "no answer on the e-publication question", refused: () => !sale({ ...ESS, publication: null } as never, "DE", "DE").ok, item: /not yet marked, on the product, as not an e-publication/ },
    { case: "a product that ships", refused: () => !sale({ ...ESS, link: null, shipping: { countries: ["DE"] } } as never, "DE", "DE").ok, item: /^Products that ship$/ },
    { case: "nothing to deliver online and no call", refused: () => !sale({ ...ESS, link: null }, "DE", "DE").ok, item: /nothing to deliver online and no live call/ },
    { case: "a bundle in a cart", refused: () => !euCartGate({ products: [{ ...ESS, bundle: ["link"] }], ...at("DE", "DE"), records: COLLECT, vatSwitch: both, now: NOW, rates: RATES }).ok, item: /^A bundle in a cart$/ },
    { case: "a buyer in Spain", refused: () => !sale(ESS, "ES", "ES").ok && words.refusedPlaces.includes("Spain"), item: /^Buyers in these places$/ },
  ];
  for (const row of rows) {
    assert.ok(row.refused(), `${row.case}: refused`);
    assert.equal(words.refused.filter((w) => row.item.test(w)).length, 1, `${row.case}: named by exactly one item`);
  }
  // The control: the same link alone, a live call alone and the same bundle without the call are not refused.
  assert.deepEqual(sale(ESS, "FR", "FR"), { ok: true, collect: { country: "FR" } });
  assert.equal(sale(call, "FR", "FR").ok, true, "a live call alone is sold as before");
  assert.deepEqual(sale({ ...ESS, bundle: ["link"] }, "FR", "FR", mixedMembers), { ok: true, collect: { country: "FR" } }, "the bundle without the call is charged");
});

test("the behavior holds the future: every kind the words promise is charged, every item of the list is a refusal (coord 9b51's MEDIUM, LEVE 1)", () => {
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })!;
  const both: SwitchInput = { ...EU_ON, uk: UK_ON.uk, reviews: [...(EU_ON.reviews ?? []), ...(UK_ON.reviews ?? [])] };
  const at = (country: string) => ({ headers: new Headers({ "x-vercel-ip-country": country }), form: new URLSearchParams({ billing_country: country }) });
  const gate = (product: EuSupplyFields, country: string) => euSaleGate({ product, ...at(country), records: COLLECT, vatSwitch: both, now: NOW, rates: RATES });
  const online = { ...ESS, link: null };
  // What the words promise, by name: "a download, a link, license keys, a recorded course or a private podcast".
  const promised: Record<string, EuSupplyFields> = {
    "a download": { ...online, file: { name: "pack.zip" } },
    "a link": ESS,
    "license keys": { ...online, keys: { count: 10 } },
    "a recorded course": { ...online, course: { lessons: 3 } },
    "a private podcast": { ...online, podcast: { episodes: 2 } },
  };
  for (const text of [words.terms.join(" "), words.pricing.join(" ")]) for (const name of Object.keys(promised)) assert.ok(text.includes(name), `the words promise ${name}`);
  for (const [name, product] of Object.entries(promised)) {
    for (const country of ["DE", "GB"]) assert.deepEqual(gate(product, country), { ok: true, collect: { country } }, `${name} to ${country} is charged VAT, as promised`);
  }
  // Every item of the list is a refusal, each proved by what the code does.
  const body = (extra: Record<string, string>) => new URLSearchParams({ mode: "payment", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "eur", "line_items[0][price_data][unit_amount]": "10000", "adaptive_pricing[enabled]": "false", ...extra });
  const input = { country: "DE", chooseYourPrice: false, buyerCurrencyLive: false, now: NOW, costsCents: () => 10 };
  const throws = (run: () => void) => { try { run(); return false; } catch { return true; } };
  const onlyConsumerGate = (file: string) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    return source.includes("consumerGate(") && !source.includes("euSaleGate(") && !source.includes("euCartGate(") && !consumerGate({ product: ESS, ...at("DE") }).ok;
  };
  const call = { ...online, call: { minutes: 30 } } as never as EuSupplyFields;
  const checkoutSource = readFileSync(join(process.cwd(), "lib/store-checkout.ts"), "utf8");
  const cartSource = readFileSync(join(process.cwd(), "lib/cart-checkout.ts"), "utf8");
  const proofs: Record<string, () => boolean> = {
    "Products that ship": () => !gate({ ...online, shipping: { countries: ["DE"] } } as never, "DE").ok,
    "Subscriptions and memberships": () => throws(() => applyEuCollect(body({ "subscription_data[metadata][x]": "1" }), input)),
    "Payment plans": () => throws(() => applyEuCollect(body({ mode: "subscription" }), input)),
    "Pay-what-you-want prices": () => throws(() => applyEuCollect(body({}), { ...input, chooseYourPrice: true })),
    // Every checkout of a store that has discounts opens Stripe's code box, typed into or not (coord 85bd's MEDIUM A).
    "Any sale in a store that offers discount codes, even when no code is typed": () => throws(() => applyEuCollect(body({ allow_promotion_codes: "true" }), input))
      && /\} else if \(store\.hasDiscounts && !pwyw\) \{[\s\S]*?body\.set\("allow_promotion_codes", "true"\)/.test(checkoutSource)
      && /const box = !discounted && store\.hasDiscounts;[\s\S]*?else if \(box\) body\.set\("allow_promotion_codes", "true"\)/.test(cartSource),
    // Each reduced price goes on the checkout as a Stripe discount, which applyEuCollect refuses.
    "A product at a reduced price: on sale, or at an introductory, member, fair, welcome or win-back price, or with a returning-buyer code": () => throws(() => applyEuCollect(body({ "discounts[0][coupon]": "x" }), input))
      && ["sale", "intro", "member", "fair", "welcome", "winback", "returning"].every((mark) => new RegExp(`body\\.set\\("discounts\\[0\\]\\[coupon\\]"[^\\n]*\\n\\s*body\\.set\\("metadata\\[${mark}\\]"`).test(checkoutSource) || new RegExp(`body\\.set\\("discounts\\[0\\]\\[coupon\\]"[\\s\\S]{0,400}?metadata\\[${mark}\\]`).test(checkoutSource)),
    "Prices converted to the buyer's own currency": () => throws(() => applyEuCollect(body({}), { ...input, buyerCurrencyLive: true })),
    "More than one of the same product": () => throws(() => applyEuCollect(body({ "line_items[0][quantity]": "2" }), input)),
    "Other products added to one product's checkout": () => throws(() => applyEuCollect(body({ "line_items[1][quantity]": "1", "line_items[1][price_data][currency]": "eur", "line_items[1][price_data][unit_amount]": "500" }), input)) && readFileSync(join(process.cwd(), "app/api/store/checkout/route.ts"), "utf8").includes("gateBoxes: (boxes) => consumerGate("),
    "A bundle in a cart": () => !euCartGate({ products: [{ ...ESS, bundle: ["link"] }], ...at("DE"), records: COLLECT, vatSwitch: both, now: NOW, rates: RATES }).ok,
    "Payments through PayPal": () => onlyConsumerGate("app/api/store/paypal/checkout/route.ts"),
    "The offer shown after paying": () => onlyConsumerGate("lib/upsell.ts"),
    "Tips and payment requests": () => onlyConsumerGate("app/api/store/tip/route.ts") && onlyConsumerGate("app/api/store/pay-request/route.ts"),
    "E-books and other e-publications, which are books, newspapers or magazines read on a screen": () => !gate({ ...ESS, publication: true }, "DE").ok && !gate({ ...ESS, publication: true }, "GB").ok,
    "A product you have not yet marked, on the product, as not an e-publication": () => !gate({ ...ESS, publication: null } as never, "DE").ok,
    "A product with nothing to deliver online and no live call, so we cannot tell what it is": () => !gate(online, "DE").ok,
    "A bundle that combines a live call with something delivered online": () => !euSaleGate({ product: { ...ESS, bundle: ["link", "call"] }, members: new Map([["link", ESS], ["call", call]]), ...at("FR"), records: COLLECT, vatSwitch: both, now: NOW, rates: RATES }).ok,
    "Buyers in these places": () => words.refusedPlaces.length > 0 && !gate(ESS, "ES").ok && !gate(ESS, "IM").ok,
    "A sale where the buyer's internet address or billing address shows no country, or the two show different countries": () =>
      !euSaleGate({ product: ESS, headers: new Headers(), form: new URLSearchParams({ billing_country: "DE" }), records: COLLECT, vatSwitch: both, now: NOW, rates: RATES }).ok
      && !euSaleGate({ product: ESS, headers: new Headers({ "x-vercel-ip-country": "DE" }), form: new URLSearchParams(), records: COLLECT, vatSwitch: both, now: NOW, rates: RATES }).ok
      && !euSaleGate({ product: ESS, headers: new Headers({ "x-vercel-ip-country": "DE" }), form: new URLSearchParams({ billing_country: "FR" }), records: COLLECT, vatSwitch: both, now: NOW, rates: RATES }).ok,
    // The EU side reads only euros and pounds, whatever allowance exists; the UK side declares any currency in pounds (coord 85bd's MEDIUM B).
    "Sales to buyers in the European Union in a currency other than the euro": () => {
      // The EU path declares in euros: the return currency it asks for is "eur" (spied), so a sale in pounds or dollars
      // needs an allowance against the euro, and none is reviewed (REVIEWED_VAT_FX_ALLOWANCES), so it is refused.
      const asked: (string | undefined)[] = [];
      const spy = (vat: number, currency: string, back?: string) => { asked.push(back); return 10; };
      for (const currency of ["eur", "gbp"]) applyEuCollect(body({ "line_items[0][price_data][currency]": currency }), { ...input, costsCents: spy, rates: RATES });
      const allowance = (currency: string) => ({ currency, bps: 200, source: "https://example.invalid/fx", checkedOn: "2026-11-01", validThrough: "2026-12-31" });
      const reviewedPlusEur = [...REVIEWED_VAT_FX_ALLOWANCES, allowance("eur")];
      return asked.every((back) => back === "eur") && asked.length === 2
        && !REVIEWED_VAT_FX_ALLOWANCES.some((a) => a.against === "eur")
        && vatCollectionCostOf(190, "eur", reviewedPlusEur, NOW, "eur") !== null
        && ["gbp", "usd", "cad", "aud"].every((currency) => vatCollectionCostOf(190, currency, reviewedPlusEur, NOW, "eur") === null)
        && vatCollectionCostOf(190, "usd", [allowance("gbp"), { ...allowance("usd"), against: "gbp" as const }], NOW, "gbp") !== null;
    },
    "Any other sale whose VAT, or the cost of receiving it, we cannot work out": () => throws(() => applyEuCollect(body({}), { ...input, costsCents: () => null })),
  };
  assert.deepEqual([...words.refused].sort(), Object.keys(proofs).sort(), "every item of the list has its own proof, and no proof is of an item the list lacks");
  for (const [item, proof] of Object.entries(proofs)) assert.ok(proof(), `refused, as the list says: ${item}`);
});

test("the places follow the side that is charging (coord 9b51's LEVE 2)", () => {
  const euOnly = [COLLECT[0], { ...COLLECT[1], treatment: "refuse-consumers" }];
  const ukOnly = [{ ...COLLECT[0], treatment: "refuse-consumers" }, COLLECT[1]];
  const eu = vatFeeWords({ records: euOnly, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })!;
  const uk = vatFeeWords({ records: ukOnly, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })!;
  const all = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })!;
  assert.match(eu.refusedLead.terms, /consumer in the European Union;/);
  assert.ok(eu.refusedPlaces.includes("Spain") && !eu.refusedPlaces.includes("the Isle of Man"), "EU only: no UK place under the European Union");
  assert.match(uk.refusedLead.terms, /consumer in the United Kingdom;/);
  assert.deepEqual(uk.refusedPlaces, ["the Isle of Man"], "UK only: no EU place under the United Kingdom");
  assert.ok(eu.refused.some((w) => /European Union in a currency other than the euro$/.test(w)), "EU: the currency item");
  assert.ok(!uk.refused.some((w) => /European Union/.test(w)), "UK only: no item about the European Union");
  assert.ok(all.refusedPlaces.includes("the French part of Saint Martin") && !all.refusedPlaces.includes("Saint Martin"), "never read as Sint Maarten, which is sold");
  for (const words of [eu, uk, all]) assert.ok(words.terms.includes("Marktmorgen does not refund it.") && words.pricing.includes("Marktmorgen does not refund it."), "the Stripe fee on the VAT is not refunded (IV (j) 2)");
  assert.deepEqual(all.refusedPlaces, Object.values(VAT_REFUSED_PLACE_NAMES), "both: every place");
});
