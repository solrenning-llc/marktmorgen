/**
 * EU VAT under art. 9a, unit 8a rebuilt as unit 2 (IVA, 14/11/2026): the quarterly non-Union OSS return from the
 * art. 63c records, in the shape of Annex III of Regulation 2020/194, with the rules of the Commission's OSS guide
 * (revised July 2026, read 14/11/2026): a nil return when nothing happened; the deadline at the end of the following
 * month; the ECB rate of the quarter's last day (or the next publication) in integer cents; part 2 never negative;
 * corrections of earlier quarters within three years of their deadline, at the rate of the quarter they correct, the
 * older ones listed apart; negative balances never set off; the export file box by box. Synthetic only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ossDeadlines, ossKeepUntil, ossReturn, ossReturnCsv } from "@/lib/eu-vat-return";
import { euVatAdjustment, euVatRecord } from "@/lib/eu-vat-record";
import type { EcbRates } from "@/lib/ecb-rates";

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
const refund = (record: ReturnType<typeof sale>, day: string, taxable: number, vat: number) =>
  euVatAdjustment(record, { at: at(day), taxableCents: -taxable, vatCents: -vat, reason: "refund" })!;
const none: EcbRates = new Map();
const rates = (entries: [string, string, string][]): EcbRates => {
  const out = new Map<string, Map<string, string>>();
  for (const [currency, day, value] of entries) out.set(currency, (out.get(currency) ?? new Map()).set(day, value));
  return out;
};

test("a quarter with nothing is a nil return, due at the end of the following month", () => {
  const result = ossReturn([], { year: 2027, quarter: 1, rates: none, filedOn: "2027-04-02" });
  assert.deepEqual(result, {
    period: "2027-Q1", annexPeriod: "Q1.2027", firstDay: "2027-01-01", lastDay: "2027-03-31", deadline: "2027-04-30", currency: "EUR",
    nil: true, lines: [], corrections: [], outsideOss: [], balances: [], totalEuroCents: 0, rates: [],
  });
  assert.equal(ossReturn([], { year: 2027, quarter: 4, rates: none, filedOn: "2028-01-05" })?.deadline, "2028-01-31");
  assert.equal(ossReturn([], { year: 2027, quarter: 2, rates: none, filedOn: "2027-07-01" })?.deadline, "2027-07-31");
  assert.equal(ossReturn([], { year: 2027, quarter: 3, rates: none, filedOn: "2027-10-01" })?.deadline, "2027-10-31");
});

test("no return is built before its quarter has ended", () => {
  assert.equal(ossReturn([], { year: 2027, quarter: 1, rates: none, filedOn: "2027-03-31" }), null);
  assert.equal(ossReturn([], { year: 2027, quarter: 1, rates: none, filedOn: "2027-02-10" }), null);
});

test("the quarter's sales per Member State and rate, refunds of the quarter's own sales netted in, balances and total", () => {
  const a = refund(sale("cs_a", "2027-01-10", "DE", 1000, 1900), "2027-02-01", 500, 95);
  const b = sale("cs_b", "2027-03-31", "DE", 2000, 1900);
  const c = sale("cs_c", "2027-02-15", "FR", 1000, 2000);
  const outside = sale("cs_d", "2026-12-31", "DE", 3000, 1900);
  const whole = refund(sale("cs_e", "2027-01-20", "IT", 1000, 2200), "2027-01-21", 1000, 220);
  const result = ossReturn([a, b, c, outside, whole], { year: 2027, quarter: 1, rates: none, filedOn: "2027-04-10" })!;
  assert.deepEqual(result.lines, [
    { memberState: "DE", rate: "standard", basisPoints: 1900, taxableEuroCents: 2500, vatEuroCents: 475 },
    { memberState: "FR", rate: "standard", basisPoints: 2000, taxableEuroCents: 1000, vatEuroCents: 200 },
  ], "a sale refunded in full in its own quarter declares nothing");
  assert.deepEqual(result.balances, [{ memberState: "DE", vatEuroCents: 475 }, { memberState: "FR", vatEuroCents: 200 }]);
  assert.equal(result.totalEuroCents, 675);
  assert.equal(result.nil, false);
});

test("another currency converts once per sum at the ECB rate of the quarter's last day, or the next publication", () => {
  const usd = sale("cs_usd", "2027-02-10", "DE", 1000, 1900, "usd");
  // 2027-03-31 is a Wednesday: the rate of that day.
  const result = ossReturn([usd], { year: 2027, quarter: 1, rates: rates([["USD", "2027-03-31", "1.0800"], ["USD", "2027-04-01", "1.2000"]]), filedOn: "2027-04-05" })!;
  assert.deepEqual(result.lines, [{ memberState: "DE", rate: "standard", basisPoints: 1900, taxableEuroCents: 926, vatEuroCents: 176 }]);
  assert.deepEqual(result.rates, [{ currency: "USD", period: "2027-Q1", perEuro: "1.0800", day: "2027-03-31" }]);
  // No publication on the last day: the next day of publication (art. 366(2)).
  const later = ossReturn([usd], { year: 2027, quarter: 1, rates: rates([["USD", "2027-04-01", "1.2000"]]), filedOn: "2027-04-05" })!;
  assert.deepEqual(later.rates, [{ currency: "USD", period: "2027-Q1", perEuro: "1.2000", day: "2027-04-01" }]);
  // A rate before the last day is never used, and none at all leaves the return unknown.
  assert.equal(ossReturn([usd], { year: 2027, quarter: 1, rates: rates([["USD", "2027-03-30", "1.0800"]]), filedOn: "2027-04-05" }), null);
  assert.equal(ossReturn([usd], { year: 2027, quarter: 1, rates: none, filedOn: "2027-04-05" }), null);
});

test("a refund this quarter of an earlier quarter's sale corrects that quarter, at that quarter's rate; the balance may go negative but the total never does", () => {
  const old = refund(sale("cs_old", "2026-12-20", "DE", 10000, 1900, "usd"), "2027-01-05", 10000, 1900);
  const small = sale("cs_new", "2027-02-01", "DE", 1000, 1900);
  const fr = sale("cs_fr", "2027-02-01", "FR", 1000, 2000);
  const result = ossReturn([old, small, fr], {
    year: 2027, quarter: 1, filedOn: "2027-04-02",
    rates: rates([["USD", "2026-12-31", "1.0000"], ["USD", "2027-03-31", "2.0000"]]),
  })!;
  assert.deepEqual(result.corrections, [{ period: "2026-Q4", memberState: "DE", vatEuroCents: -1900 }], "converted at the end of 2026-Q4, the quarter it corrects");
  assert.deepEqual(result.balances, [{ memberState: "DE", vatEuroCents: 190 - 1900 }, { memberState: "FR", vatEuroCents: 200 }]);
  assert.equal(result.totalEuroCents, 200, "a negative balance is never set off against another Member State");
});

test("a correction more than three years after the corrected return's deadline is listed apart, not in the return", () => {
  const old = refund(sale("cs_2026", "2026-02-10", "DE", 1000, 1900), "2029-05-01", 1000, 190);
  // 2026-Q1's deadline is 2026-04-30; correctable through the OSS until 2029-04-30.
  assert.deepEqual(ossDeadlines("2026-02-10"), { deadline: "2026-04-30", correctableUntil: "2029-04-30" });
  const result = ossReturn([old], { year: 2029, quarter: 2, rates: none, filedOn: "2029-07-02" })!;
  assert.deepEqual(result.corrections, []);
  assert.deepEqual(result.outsideOss, [{ period: "2026-Q1", memberState: "DE", vatEuroCents: -190 }]);
  assert.equal(result.nil, true, "nothing of the OSS to declare");
  const inTime = refund(sale("cs_2026b", "2026-05-10", "DE", 1000, 1900), "2029-05-01", 1000, 190);
  // 2026-Q2's deadline is 2026-07-31: still correctable on 2029-07-02.
  assert.deepEqual(ossReturn([inTime], { year: 2029, quarter: 2, rates: none, filedOn: "2029-07-02" })!.corrections, [{ period: "2026-Q2", memberState: "DE", vatEuroCents: -190 }]);
});

test("records are kept until 31 December of the tenth year after the transaction's year", () => {
  assert.equal(ossKeepUntil("2027-01-01"), "2037-12-31");
  assert.equal(ossKeepUntil("2027-12-31"), "2037-12-31");
  assert.equal(ossKeepUntil("2027-02-30"), null);
});

test("anything that does not read leaves the whole return unknown", () => {
  const a = sale("cs_a", "2027-01-10", "DE", 1000, 1900);
  const filedOn = "2027-04-02";
  assert.equal(ossReturn([a], { year: 2027, quarter: 5, rates: none, filedOn }), null);
  assert.equal(ossReturn([{ ...a, date: "2027-13-01" }], { year: 2027, quarter: 1, rates: none, filedOn }), null);
  assert.equal(ossReturn([null as never], { year: 2027, quarter: 1, rates: none, filedOn }), null);
  assert.equal(ossReturn([{ ...a, taxableCents: -1 }], { year: 2027, quarter: 1, rates: none, filedOn }), null, "part 2 cannot be negative");
  assert.equal(ossReturn([a], { year: 2027, quarter: 1, rates: none, filedOn: "02/04/2027" }), null);
});

test("the export file lists every box of the return, in euro with two decimals, only with the OSS number", () => {
  const a = sale("cs_a", "2027-01-10", "DE", 1000, 1900);
  const old = refund(sale("cs_old", "2026-12-20", "FR", 1000, 2000), "2027-01-05", 1000, 200);
  const result = ossReturn([a, old], { year: 2027, quarter: 1, rates: none, filedOn: "2027-04-02" })!;
  assert.equal(ossReturnCsv(result, ""), null, "nothing until the owner's registration is configured");
  assert.equal(
    ossReturnCsv(result, "EU372000001"),
    [
      "part,box,item,member_state,period,rate_percent,amount_eur",
      "1,1,VAT identification number,,,,EU372000001",
      "1,2,Tax period,,Q1.2027,,",
      "1,3,Currency,,,,EUR",
      "2,4.1,Member State of consumption,DE,Q1.2027,,",
      "2,7.1,Taxable amount at standard rate,DE,Q1.2027,19.00,10.00",
      "2,8.1,VAT amount at standard rate,DE,Q1.2027,19.00,1.90",
      "3,24.1,VAT correction,FR,Q4.2026,,-2.00",
      "4,25.1,Balance of VAT due,DE,Q1.2027,,1.90",
      "4,25.2,Balance of VAT due,FR,Q1.2027,,-2.00",
      "5,26,Total VAT due,,Q1.2027,,1.90",
      "",
    ].join("\n"),
  );
  const nil = ossReturn([], { year: 2027, quarter: 2, rates: none, filedOn: "2027-07-01" })!;
  assert.match(ossReturnCsv(nil, "EU372000001")!, /^5,26,Total VAT due \(nil return\),,Q2\.2027,,0\.00$/m);
});

test("input that is not the expected shape never throws: the return is unknown", () => {
  const a = sale("cs_a", "2027-01-10", "DE", 1000, 1900);
  assert.equal(ossReturn([a], null as never), null);
  assert.equal(ossReturn([a], { year: 2027, quarter: 1, rates: {} as never, filedOn: "2027-04-02" }), null, "rates that are not a Map");
  assert.equal(ossReturn(null as never, { year: 2027, quarter: 1, rates: none, filedOn: "2027-04-02" }), null);
});

test("an adjustment dated before its sale makes the return unknown, never a correction of a later quarter", () => {
  const a = sale("cs_may", "2027-05-01", "DE", 1000, 1900);
  const early = { ...a, adjustments: [{ date: "2027-02-01", taxableCents: -100, vatCents: -19, reason: "refund" }] };
  assert.equal(ossReturn([early], { year: 2027, quarter: 1, rates: none, filedOn: "2027-04-02" }), null);
});
