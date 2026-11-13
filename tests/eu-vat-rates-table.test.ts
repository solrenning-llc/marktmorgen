/**
 * EU VAT art. 9a, "collect" path (C2-20261113-1445-IVA-3): the standard rates of the 27 Member States, read on
 * 13/11/2026 from the Commission's TEDB (docs/eu-vat-official-sources-2026-11-13.md, branch claude2/eu-vat-official-sources
 * @1251b48e68), the only source of lib/eu-vat-amount.ts EU_VAT_RATES. One record per Member State, each with its
 * source, the day it was read and the TEDB's own situation date. The table is used only until its review date: past
 * it, no rate is given, so no EU sale can be collected on a table nobody checked again. Reduced rates (e-books) are
 * not modelled: the standard rate is the reading that never understates the tax. Pure.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EU_VAT_RATES, EU_VAT_RATES_VALID_UNTIL, euVatRateProblems, vatOnTop } from "@/lib/eu-vat-amount";
import { EU_VAT_COUNTRIES } from "@/lib/eu-vat-supply";

const TEDB = "https://ec.europa.eu/taxation_customs/tedb/";

test("one sourced record for each of the 27 Member States, and nothing else", () => {
  assert.deepEqual(euVatRateProblems(), []);
  assert.deepEqual([...new Set(EU_VAT_RATES.map((rate) => rate.country))].sort(), [...EU_VAT_COUNTRIES].sort());
  assert.equal(EU_VAT_RATES.length, 27);
  for (const rate of EU_VAT_RATES) {
    assert.equal(rate.source, TEDB, rate.country);
    assert.equal(rate.readOn, "2026-11-13", rate.country);
    assert.match(rate.situationOn ?? "", /^2026-0[17]-01$/, rate.country);
  }
});

test("the standard rates as the TEDB gives them on 13/11/2026", () => {
  const expected: Record<string, number> = {
    AT: 2000, BE: 2100, BG: 2000, CY: 1900, CZ: 2100, DE: 1900, DK: 2500, EE: 2400, ES: 2100, FI: 2550, FR: 2000, GR: 2400, HR: 2500, HU: 2700,
    IE: 2300, IT: 2200, LT: 2100, LU: 1700, LV: 2100, MT: 1800, NL: 2100, PL: 2300, PT: 2300, RO: 2100, SE: 2500, SI: 2200, SK: 2300,
  };
  assert.deepEqual(Object.fromEntries(EU_VAT_RATES.map((rate) => [rate.country, rate.basisPoints])), expected);
});

test("the TEDB's own situation date per line", () => {
  const early = EU_VAT_RATES.filter((rate) => rate.situationOn === "2026-01-01").map((rate) => rate.country).sort();
  assert.deepEqual(early, ["CY", "GR", "PT"]);
});

test("VAT on top from the table while it is valid, and none once its review date has passed", () => {
  const before = new Date("2026-11-13T12:00:00Z");
  assert.deepEqual(vatOnTop(10_000, "DE", EU_VAT_RATES, before), { priceCents: 10_000, vatCents: 1_900, totalCents: 11_900, basisPoints: 1900, country: "DE" });
  assert.equal(vatOnTop(1_000, "FI", EU_VAT_RATES, before)?.vatCents, 255);
  assert.equal(EU_VAT_RATES_VALID_UNTIL, "2026-12-31");
  assert.notEqual(vatOnTop(10_000, "HU", EU_VAT_RATES, new Date("2026-12-31T23:59:59Z")), null);
  assert.equal(vatOnTop(10_000, "HU", EU_VAT_RATES, new Date("2027-01-01T00:00:00Z")), null);
  assert.deepEqual(euVatRateProblems(EU_VAT_RATES, new Date("2027-01-01T00:00:00Z")), ["the official rate table is past its review date, 2026-12-31"]);
});
