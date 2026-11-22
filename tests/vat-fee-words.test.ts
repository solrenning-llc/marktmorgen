/**
 * 793 [IV3] unit 2, item (a) (OWNER-20261121-1529-ART9A-PENDING-DECISIONS, item 2; OWNER-20261122-0022, option A):
 * what the Terms and the pricing page tell a creator about the VAT Marktmorgen collects as the deemed supplier, with a
 * worked example in figures, from lib/vat-fee-words.ts.
 *
 *   - Shown only while that VAT is really collected (euVatCollectOn / ukVatCollectOn) and its costs are known: today,
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
import { EXAMPLE_PROCESSING_BPS, termsLastUpdated, vatFeeWords } from "@/lib/vat-fee-words";
import { vatOnTop } from "@/lib/eu-vat-amount";
import { ukVatOnTop } from "@/lib/uk-vat";
import { vatCollectionCostOf, type VatFxAllowance } from "@/lib/eu-vat-collection-cost";
import type { SwitchInput } from "@/lib/vat-registrations";

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

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
const halfUp = (cents: number, bps: number) => Math.floor((cents * bps + 5_000) / 10_000);
const all = (words: NonNullable<ReturnType<typeof vatFeeWords>>) => [...words.terms, ...words.pricing, ...words.example].join(" ");

test("today nothing is shown: both switches are off", () => {
  assert.equal(vatFeeWords(), null);
  assert.equal(vatFeeWords({ eu: OFF, uk: OFF, now: NOW, allowances: ALLOWANCES }), null);
});

test("a switch on but an unknown cost of receiving the VAT shows nothing, never a zero cost", () => {
  assert.equal(vatFeeWords({ eu: EU_ON, uk: UK_ON, now: NOW, allowances: [] }), null);
});

test("the EU example is worked out by the code that charges", () => {
  const words = vatFeeWords({ eu: EU_ON, uk: OFF, now: NOW, allowances: ALLOWANCES });
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
  const words = vatFeeWords({ eu: OFF, uk: UK_ON, now: NOW, allowances: ALLOWANCES });
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
  const words = vatFeeWords({ eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES });
  assert.ok(words);
  assert.deepEqual(words.places, ["EU", "UK"]);
  assert.equal(words.figures.currency, "eur");
  assert.match(all(words), /European Union and the United Kingdom/);
});

test("the words keep the owner's rule, item 2 (a) to (d), option A", () => {
  const words = vatFeeWords({ eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES });
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

test("short sentences in plain US English", () => {
  const words = vatFeeWords({ eu: EU_ON, uk: UK_ON, now: NOW, allowances: ALLOWANCES });
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
  const words = vatFeeWords({ eu: later, uk: OFF, now: NOW, allowances: ALLOWANCES });
  assert.ok(words);
  assert.equal(words.since, "2026-11-20");
  const lateAllowance = ALLOWANCES.map((a) => ({ ...a, checkedOn: "2026-11-21" }));
  assert.equal(vatFeeWords({ eu: later, uk: OFF, now: NOW, allowances: lateAllowance })?.since, "2026-11-21");
  // One day earlier the words are not shown at all, so the Terms' date is never earlier than the text.
  const dayBefore = new Date("2026-11-19T12:00:00Z");
  assert.equal(vatFeeWords({ eu: { ...later, now: dayBefore }, uk: OFF, now: dayBefore, allowances: ALLOWANCES }), null);
  const both = vatFeeWords({ eu: EU_ON, uk: { ...UK_ON, reviews: [{ jurisdiction: "UK", registration: "123456789", reviewedOn: "2026-11-18", reviewer: "owner" }] }, now: NOW, allowances: ALLOWANCES });
  assert.equal(both?.since, "2026-11-18", "with both on, the later place's dates count");
});

test("the Terms' Last updated date moves with the VAT paragraph, never earlier than its first day (section 15)", () => {
  assert.equal(termsLastUpdated("2026-11-10", null), "November 10, 2026");
  const words = vatFeeWords({ eu: { ...EU_ON, reviews: [{ jurisdiction: "EU", registration: "EU372000000", reviewedOn: "2026-11-20", reviewer: "owner" }] }, uk: OFF, now: NOW, allowances: ALLOWANCES });
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
