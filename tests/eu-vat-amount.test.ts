/**
 * EU VAT under art. 9a, part 2 of the build, unit 3: the VAT added on top of the buyer's price (docs/eu-vat-article-9a.md,
 * "The owner's design": on top of the buyer's price or from the creator's payout, never from Marktmorgen's commission).
 *
 * A rate is used only from the table with its official source and the day it was read; a country with no rate there is
 * no sale (null), never a guessed or default rate. The table starts empty: no rate is typed from memory, they come with
 * the sources of part 1. The amount is the price times the rate, rounded half up to the currency's smallest unit; the
 * price itself and Marktmorgen's share never change. Synthetic only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EU_VAT_RATES, type EuVatRate, euVatRateProblems, vatOnTop } from "@/lib/eu-vat-amount";

const sourced = (country: string, basisPoints: number): EuVatRate => ({ country, basisPoints, source: "https://example.invalid/official-rate-source", readOn: "2026-11-13" });

test("the table starts empty: no rate is typed from memory", () => {
  assert.equal(EU_VAT_RATES.length, 0);
  assert.deepEqual(euVatRateProblems(), []);
});

test("a country with no sourced rate is no sale, never a default rate", () => {
  assert.equal(vatOnTop(1000, "DE"), null);
  assert.equal(vatOnTop(1000, "DE", [sourced("FR", 2000)]), null);
});

test("VAT on top: the price times the rate, rounded half up, the price unchanged", () => {
  const table = [sourced("DE", 1900), sourced("HU", 2700)];
  assert.deepEqual(vatOnTop(1000, "DE", table), { priceCents: 1000, vatCents: 190, totalCents: 1190, basisPoints: 1900, country: "DE" });
  assert.deepEqual(vatOnTop(999, "HU", table), { priceCents: 999, vatCents: 270, totalCents: 1269, basisPoints: 2700, country: "HU" });
  // 5 * 0.19 = 0.95 → 1 (half up); 3 * 0.19 = 0.57 → 1; 2 * 0.19 = 0.38 → 0.
  assert.equal(vatOnTop(5, "DE", table)?.vatCents, 1);
  assert.equal(vatOnTop(2, "DE", table)?.vatCents, 0);
  assert.equal(vatOnTop(0, "DE", table)?.vatCents, 0);
});

test("a price that is not a whole number of cents, or a negative one, is no sale", () => {
  const table = [sourced("DE", 1900)];
  for (const price of [Number.NaN, 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) assert.equal(vatOnTop(price, "DE", table), null, String(price));
});

test("a rate record without its source, its day or a sane rate is a problem, and never used", () => {
  const bad: EuVatRate[] = [
    { ...sourced("DE", 1900), source: "" },
    { ...sourced("FR", 2000), readOn: "2026-02-31" },
    { ...sourced("IT", 22000), basisPoints: 22000 },
    { ...sourced("XX", 2000) },
    sourced("AT", 2000),
    sourced("AT", 2000),
  ];
  const problems = euVatRateProblems(bad);
  assert.ok(problems.some((p) => p.startsWith("DE")), problems.join("; "));
  assert.ok(problems.some((p) => p.startsWith("FR")));
  assert.ok(problems.some((p) => p.startsWith("IT")));
  assert.ok(problems.some((p) => p.startsWith("XX")));
  assert.ok(problems.some((p) => p.startsWith("AT")));
  for (const country of ["DE", "FR", "IT", "XX", "AT"]) assert.equal(vatOnTop(1000, country, bad), null, country);
});
