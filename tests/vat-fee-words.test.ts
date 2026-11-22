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
import { vatCollectionCostOf, type VatFxAllowance } from "@/lib/eu-vat-collection-cost";
import type { SwitchInput } from "@/lib/vat-registrations";
import { dynamicPolicy, isDynamicPage, staticPolicy } from "@/lib/csp";
import { VAT_BODY_REFUSALS, VAT_REFUSED_SALES } from "@/lib/vat-fee-words";
import { applyEuCollect, euSaleGate } from "@/lib/eu-vat-collect";

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
    assert.match(text, /Live calls and anything that ships are not covered/, "the \"human\" and \"goods\" supplies are named as outside it");
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
  const product = { kind: "download", publication: false } as never;
  const gate = euSaleGate({ product, headers, form, records: refusing, vatSwitch: EU_ON, now: NOW });
  assert.equal(gate.ok && gate.collect !== null, false, "the checkout does not collect where the words would not show");
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
  assert.ok(VAT_REFUSED_SALES.some((r) => r.words.includes("payment plans") && (r.checks as readonly string[]).includes("not a one-off payment")), "payment plans are named");
  const words = vatFeeWords({ records: COLLECT, eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES })!;
  for (const part of [words.terms, words.pricing]) {
    const text = part.join(" ");
    for (const r of VAT_REFUSED_SALES) assert.ok(text.includes(r.words), `named: ${r.words}`);
    assert.ok(!/membership's content/.test(text), "a subscription is never promised");
  }
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
  assert.match(words.terms.join(" "), /does not accept these sales from a consumer in .*; nothing is charged for them\./);
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
