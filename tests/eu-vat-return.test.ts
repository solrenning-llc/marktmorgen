/**
 * EU VAT under art. 9a, part 2 of the build, unit 8a: the quarterly non-Union OSS return's figures from the art. 63c
 * records (docs/eu-vat-article-9a.md, "The code that would be needed", point 6). Per Member State: the taxable amount
 * and the VAT of the quarter's sales at each rate, and, apart, the corrections of earlier quarters (refunds dated in
 * this quarter on sales of an earlier one). Amounts in euros at the exchange rate given for the quarter's last day; a
 * currency with no rate given leaves the return unknown (null), never converted at a guess or left out. Pure.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ossReturn } from "@/lib/eu-vat-return";
import { euVatAdjustment, euVatRecord } from "@/lib/eu-vat-record";

const at = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;
function sale(id: string, day: string, country: string, price: number, bp: number, currency = "eur") {
  const vatCents = Math.floor((price * bp + 5000) / 10000);
  return euVatRecord({
    sale: id, store: "s".repeat(32), supply: "ess", service: "Digital download", at: at(day), currency,
    vat: { priceCents: price, vatCents, totalCents: price + vatCents, basisPoints: bp, country },
    place: { kind: "eu", country, evidence: { ip: country, billing: country } },
    payments: [{ at: at(day), cents: price + vatCents }], customerName: null,
  })!;
}

test("the quarter's sales per Member State and rate, refunds of the quarter's own sales netted in", () => {
  let a = sale("cs_a", "2027-01-10", "DE", 1000, 1900);
  a = euVatAdjustment(a, { at: at("2027-02-01"), taxableCents: -500, vatCents: -95, reason: "refund" })!;
  const b = sale("cs_b", "2027-03-31", "DE", 2000, 1900);
  const c = sale("cs_c", "2027-02-15", "FR", 1000, 2000);
  const outside = sale("cs_d", "2026-12-31", "DE", 3000, 1900);
  const result = ossReturn([a, b, c, outside], { year: 2027, quarter: 1, eurPerUnit: { EUR: 1 } });
  assert.deepEqual(result, {
    period: "2027-Q1",
    lines: [
      { memberState: "DE", basisPoints: 1900, taxableEuroCents: 2500, vatEuroCents: 475 },
      { memberState: "FR", basisPoints: 2000, taxableEuroCents: 1000, vatEuroCents: 200 },
    ],
    corrections: [],
  });
});

test("a refund this quarter of a sale of an earlier quarter is a correction of that quarter, not netted in", () => {
  let old = sale("cs_old", "2026-12-20", "DE", 1000, 1900);
  old = euVatAdjustment(old, { at: at("2027-01-05"), taxableCents: -1000, vatCents: -190, reason: "refund" })!;
  const result = ossReturn([old], { year: 2027, quarter: 1, eurPerUnit: { EUR: 1 } });
  assert.deepEqual(result, { period: "2027-Q1", lines: [], corrections: [{ period: "2026-Q4", memberState: "DE", vatEuroCents: -190 }] });
});

test("another currency converts at the rate given; a currency with no rate leaves the return unknown", () => {
  const usd = sale("cs_usd", "2027-01-10", "DE", 1000, 1900, "usd");
  assert.deepEqual(ossReturn([usd], { year: 2027, quarter: 1, eurPerUnit: { EUR: 1, USD: 0.9 } })?.lines, [
    { memberState: "DE", basisPoints: 1900, taxableEuroCents: 900, vatEuroCents: 171 },
  ]);
  assert.equal(ossReturn([usd], { year: 2027, quarter: 1, eurPerUnit: { EUR: 1 } }), null);
  assert.equal(ossReturn([usd], { year: 2027, quarter: 1, eurPerUnit: { EUR: 1, USD: Number.NaN } }), null);
});

test("a quarter that is not one, or a record that is not whole, leaves the return unknown", () => {
  const a = sale("cs_a", "2027-01-10", "DE", 1000, 1900);
  assert.equal(ossReturn([a], { year: 2027, quarter: 5, eurPerUnit: { EUR: 1 } }), null);
  assert.equal(ossReturn([{ ...a, date: "2027-13-01" }], { year: 2027, quarter: 1, eurPerUnit: { EUR: 1 } }), null);
  assert.equal(ossReturn([null as never], { year: 2027, quarter: 1, eurPerUnit: { EUR: 1 } }), null);
});
