/**
 * UK VAT, unit 3 (IVA, 14/11/2026): an electronically supplied service to a UK consumer is collected on top at the UK
 * rate (gov.uk/vat-rates, read 14/11/2026: 20%) only behind UK_VAT_COLLECT_REVIEWED, with two agreeing items of
 * location evidence (HMRC digital services guidance: "2 pieces of information"); its full VAT invoice shows the VAT in
 * sterling (Notice 700/21, 4.1) at HMRC's period rate or the UK market rate of the supply (Notice 700, 7.6), and only
 * with the owner's 9-digit VAT registration number; the record and the return's box 1 and box 6, due one month and 7
 * days after the period. Synthetic only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  UK_VAT_COLLECT_REVIEWED, UK_VAT_RATE, toPence, ukCheckout, ukInvoice, ukPlace, ukReturn, ukReturnCsv, ukVatAdjustment, ukVatOnTop, ukVatRecord,
} from "@/lib/uk-vat";

const gb = { ip: "GB", billing: "GB" };
const now = new Date("2026-11-14T12:00:00Z");
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const supplier = { name: "Example Platform LLC", address: "1 Example Street, Dover, DE 19901, United States", vatNumber: "123456789" };
const customer = { name: "Jane Example", address: "1 Example Road, London" };

test("the switch starts off and the rate is the sourced 20%", () => {
  assert.equal(UK_VAT_COLLECT_REVIEWED, false);
  assert.equal(UK_VAT_RATE.basisPoints, 2000);
  assert.equal(UK_VAT_RATE.source, "https://www.gov.uk/vat-rates");
});

test("the UK consumer needs two agreeing items; the Isle of Man is not settled; Jersey is outside", () => {
  assert.deepEqual(ukPlace(gb), { kind: "uk", evidence: gb });
  assert.deepEqual(ukPlace({ ip: "GB", billing: "US" }), { kind: "unknown", reason: "contradiction" });
  assert.deepEqual(ukPlace({ ip: "GB", billing: null }), { kind: "unknown", reason: "missing" });
  assert.deepEqual(ukPlace({ ip: "GB", billing: "GB", card: "FR" }), { kind: "unknown", reason: "contradiction" });
  assert.deepEqual(ukPlace({ ip: "IM", billing: "IM" }), { kind: "unknown", reason: "territory" });
  assert.deepEqual(ukPlace({ ip: "JE", billing: "JE" }), { kind: "outside", country: "JE" });
  assert.deepEqual(ukPlace({ ip: "XX", billing: "XX" }), { kind: "unknown", reason: "not-a-country" });
});

test("unreviewed nothing is collected; reviewed, an electronic service is collected on top, half up", () => {
  assert.deepEqual(ukCheckout({ supply: "ess", priceCents: 1000, items: gb, now }), { kind: "refuse", reason: "review" });
  assert.deepEqual(ukCheckout({ supply: "ess", priceCents: 1000, items: gb, reviewed: true, now, publication: false }), {
    kind: "collect", vat: { priceCents: 1000, vatCents: 200, totalCents: 1200, basisPoints: 2000 }, place: { kind: "uk", evidence: gb },
  });
  assert.deepEqual(ukVatOnTop(1), { priceCents: 1, vatCents: 0, totalCents: 1, basisPoints: 2000 });
  assert.deepEqual(ukVatOnTop(3), { priceCents: 3, vatCents: 1, totalCents: 4, basisPoints: 2000 }, "0.6 rounds up");
  assert.deepEqual(ukVatOnTop(1999), { priceCents: 1999, vatCents: 400, totalCents: 2399, basisPoints: 2000 }, "399.8 rounds up");
  assert.equal(ukVatOnTop(10.5), null);
});

test("goods, a live service, an unknown product, an unknown place and an expired rate are refused; outside and free go on", () => {
  for (const [supply, reason] of [["goods", "goods"], ["human", "human"], ["unknown", "supply"]] as const) {
    assert.deepEqual(ukCheckout({ supply, priceCents: 1000, items: gb, reviewed: true, now }), { kind: "refuse", reason });
  }
  assert.deepEqual(ukCheckout({ supply: "ess", priceCents: 1000, items: { ip: "GB", billing: "FR" }, reviewed: true, now }), { kind: "refuse", reason: "place" });
  assert.deepEqual(ukCheckout({ supply: "ess", priceCents: 1000, items: gb, reviewed: true, now: new Date("2027-01-01T00:00:00Z") }), { kind: "refuse", reason: "rate-expired" });
  assert.deepEqual(ukCheckout({ supply: "ess", priceCents: 1000, items: { ip: "US", billing: "US" }, now }), { kind: "outside", country: "US" });
  assert.deepEqual(ukCheckout({ supply: "free", priceCents: 0, items: gb, now }), { kind: "free" });
});

test("an electronic service is charged UK VAT only when it is classified as not an e-publication (Claude 5 on #4574 @2dc6127da7, MEDIO 1)", () => {
  // E-publications are zero-rated in the UK (VAT Act 1994 Sch. 8 Group 3, as extended by SI 2020/459). The TX policy
  // forbids picking the reading with more tax, so an unclassified product, or an e-publication, is refused, never charged 20%.
  assert.deepEqual(ukCheckout({ supply: "ess", priceCents: 1000, items: gb, reviewed: true, now }), { kind: "refuse", reason: "publication" });
  assert.deepEqual(ukCheckout({ supply: "ess", priceCents: 1000, items: gb, reviewed: true, now, publication: true }), { kind: "refuse", reason: "publication" });
  assert.equal(ukCheckout({ supply: "ess", priceCents: 1000, items: gb, reviewed: true, now, publication: false }).kind, "collect");
  // Only `false` classifies: anything else is unknown.
  for (const publication of [null, 0, "false", "no"] as unknown as boolean[]) {
    assert.deepEqual(ukCheckout({ supply: "ess", priceCents: 1000, items: gb, reviewed: true, now, publication }), { kind: "refuse", reason: "publication" });
  }
  // The review gate and the other refusals come first and are unchanged.
  assert.deepEqual(ukCheckout({ supply: "ess", priceCents: 1000, items: gb, now }), { kind: "refuse", reason: "review" });
  assert.deepEqual(ukCheckout({ supply: "ess", priceCents: 1000, items: gb, reviewed: true, now: new Date("2027-01-01T00:00:00Z"), publication: false }), { kind: "refuse", reason: "rate-expired" });
});

const vat = ukVatOnTop(1000)!;
const invoiceInput = {
  number: "MM-UK-2026-000001", suppliedAt: at("2026-11-14T12:00:00Z"), issuedAt: at("2026-11-14T12:00:01Z"), supplier, customer,
  description: "Download: Example (electronically supplied service)", currency: "GBP", vat,
};

test("the full VAT invoice has every detail of Notice 700/21, 4.1, the VAT in sterling, and needs the 9-digit number", () => {
  assert.deepEqual(ukInvoice(invoiceInput), {
    number: "MM-UK-2026-000001", timeOfSupply: "2026-11-14", issuedOn: null, supplier, customer, description: invoiceInput.description, quantity: 1,
    currency: "GBP", unitPriceCents: 1000, amountExVatCents: 1000, rateBasisPoints: 2000, vatCents: 200, totalCents: 1200, vatSterlingPence: 200, sterlingRate: null,
  });
  for (const vatNumber of ["", "GB123456789", "12345678", "1234567890"]) assert.equal(ukInvoice({ ...invoiceInput, supplier: { ...supplier, vatNumber } }), null, vatNumber);
  assert.equal(ukInvoice({ ...invoiceInput, customer: { ...customer, address: "" } }), null);
  assert.equal(ukInvoice({ ...invoiceInput, vat: { ...vat, vatCents: 199 } }), null, "VAT that is not the rate's");
  assert.equal(ukInvoice({ ...invoiceInput, issuedAt: at("2026-11-13T12:00:00Z") }), null, "issued before the supply");
});

test("in another currency the VAT is in sterling at HMRC's period rate of the month or the UK market rate of the day; never another", () => {
  const usd = { ...invoiceInput, currency: "USD" };
  assert.equal(ukInvoice(usd), null, "no rate, no invoice");
  // HMRC publishes its period rates as units of the currency per £1; the code takes them as published.
  const period = { perPound: "1.3137", basis: "hmrc-period" as const, day: "2026-11-01", source: "https://www.trade-tariff.service.gov.uk/exchange_rates" };
  const invoice = ukInvoice({ ...usd, sterling: period });
  assert.equal(invoice?.vatSterlingPence, 152); // 200 / 1.3137 = 152.24
  assert.deepEqual(invoice?.sterlingRate, period);
  assert.equal(ukInvoice({ ...usd, sterling: { ...period, day: "2026-10-01" } }), null, "another month's period rate");
  assert.equal(ukInvoice({ ...usd, sterling: { ...period, basis: "uk-market", day: "2026-11-13" } }), null, "a market rate of another day");
  assert.equal(ukInvoice({ ...usd, sterling: { ...period, basis: "ecb" as never } }), null, "the ECB's rate is not one of Notice 700's");
});

test("toPence divides by the units per £1 in integers, half up, both signs", () => {
  assert.equal(toPence(200, "1.3137"), 152);
  assert.equal(toPence(1, "2"), 1);
  assert.equal(toPence(-1, "2"), -1);
  assert.equal(toPence(-200, "1.3137"), -152);
  assert.equal(toPence(100, "abc"), null);
  assert.equal(toPence(100, "0"), null);
});

test("input that is not the expected shape never throws; 'UK' is not a country code", () => {
  assert.deepEqual(ukPlace(null as never), { kind: "unknown", reason: "missing" });
  assert.deepEqual(ukPlace({ ip: "UK", billing: "UK" }), { kind: "unknown", reason: "not-a-country" });
  assert.equal(ukReturn([], null as never), null);
  assert.equal(ukReturn(null as never, { start: "2027-04-01", end: "2027-06-30", filedOn: "2027-07-01" }), null);
  assert.equal(ukCheckout({ supply: "ess", priceCents: 1000, items: gb, reviewed: true, now: new Date(Number.NaN) }).kind, "refuse");
});

test("a refund keeps the rate's VAT on its amount and leaves no VAT on nothing", () => {
  const record = ukVatRecord({ sale: "cs_uk_2", store: "st_1", invoice: ukInvoice(invoiceInput)!, place: { kind: "uk", evidence: gb } })!;
  const later = at("2026-11-20T12:00:00Z");
  assert.notEqual(ukVatAdjustment(record, { at: later, exVatCents: -333, vatCents: -67, reason: "refund" }), null, "66.6 is 67; one cent either way is rounding");
  assert.equal(ukVatAdjustment(record, { at: later, exVatCents: -1, vatCents: -200, reason: "refund" }), null, "VAT out of proportion");
  assert.equal(ukVatAdjustment(record, { at: later, exVatCents: -1000, vatCents: -100, reason: "refund" }), null, "a full refund leaves no VAT behind");
});

test("the record, its refunds at the sale's own rate, and the return's box 1 and box 6, due one month and 7 days after", () => {
  const record = ukVatRecord({ sale: "cs_uk_1", store: "st_1", invoice: ukInvoice(invoiceInput)!, place: { kind: "uk", evidence: gb } })!;
  assert.deepEqual({ ...record, adjustments: undefined }, {
    v: 1, sale: "cs_uk_1", store: "st_1", date: "2026-11-14", currency: "GBP", exVatCents: 1000, vatCents: 200, rateBasisPoints: 2000,
    exVatPence: 1000, vatPence: 200, sterlingRate: null, location: gb, invoice: "MM-UK-2026-000001", adjustments: undefined,
  });
  const refunded = ukVatAdjustment(record, { at: at("2027-01-05T12:00:00Z"), exVatCents: -500, vatCents: -100, reason: "refund" })!;
  assert.equal(ukVatAdjustment(record, { at: at("2027-01-05T12:00:00Z"), exVatCents: -1001, vatCents: -100, reason: "refund" }), null, "never more than the sale");
  assert.equal(ukVatAdjustment(record, { at: at("2027-01-05T12:00:00Z"), exVatCents: 10, vatCents: 2, reason: "more" }), null, "a refund is a reduction");
  const q4 = ukReturn([refunded], { start: "2026-10-01", end: "2026-12-31", filedOn: "2027-01-03" })!;
  assert.deepEqual(q4, { start: "2026-10-01", end: "2026-12-31", deadline: "2027-02-07", nil: false, box1Pence: 200, box6Pence: 1000, sales: 1 });
  const q1 = ukReturn([refunded], { start: "2027-01-01", end: "2027-03-31", filedOn: "2027-04-01" })!;
  assert.deepEqual(q1, { start: "2027-01-01", end: "2027-03-31", deadline: "2027-05-07", nil: false, box1Pence: -100, box6Pence: -500, sales: 0 });
  assert.equal(ukReturn([], { start: "2027-04-01", end: "2027-06-30", filedOn: "2027-07-01" })?.nil, true);
  assert.equal(ukReturn([], { start: "2027-04-01", end: "2027-06-30", filedOn: "2027-06-30" }), null, "not before the period ended");
  assert.equal(ukReturn([], { start: "2027-04-01", end: "2027-04-31", filedOn: "2027-07-01" }), null);
});

test("the export has the figures only with the owner's VAT registration number", () => {
  const ret = ukReturn([], { start: "2027-04-01", end: "2027-06-30", filedOn: "2027-07-01" })!;
  assert.equal(ukReturnCsv(ret, ""), null);
  assert.equal(ukReturnCsv(ret, "123456789"), [
    "box,item,amount_gbp",
    ",\"VAT registration number 123456789, period 2027-04-01 to 2027-06-30, due 2027-08-07\",",
    "1,VAT due on sales (Marktmorgen's UK digital supplies),0.00",
    "6,Value of those supplies excluding VAT (add every other output of the business),0.00",
    "4,\"VAT reclaimed on purchases: from the owner's own purchase records, not filled here\",",
    "",
  ].join("\n"));
});

test("VAT taken back with no value refunded never drains a sale's VAT (Claude 7 on #4574)", () => {
  let record = ukVatRecord({ sale: "cs_uk_drain", store: "st_1", invoice: ukInvoice(invoiceInput)!, place: { kind: "uk", evidence: gb } })!;
  const later = at("2026-11-20T12:00:00Z");
  assert.equal(ukVatAdjustment(record, { at: later, exVatCents: 0, vatCents: -1, reason: "refund" }), null, "no value refunded, no VAT given back");
  // Small refunds each one cent off cannot pile up: what is left keeps the sale's proportion.
  let taken = 0;
  for (let i = 0; i < 200; i += 1) {
    const next = ukVatAdjustment(record, { at: later, exVatCents: -2, vatCents: -1, reason: "refund" });
    if (!next) break;
    record = next;
    taken += 1;
  }
  const q4 = ukReturn([record], { start: "2026-10-01", end: "2026-12-31", filedOn: "2027-01-03" })!;
  assert.ok(Math.abs(q4.box1Pence - Math.round(q4.box6Pence * 0.2)) <= 1, `box 1 ${q4.box1Pence} against box 6 ${q4.box6Pence} after ${taken} entries`);
});

test("a full refund in two halves in another currency is recorded, the last taking what is left in pence (Claude 7 on #4574)", () => {
  const period = { perPound: "1.3137", basis: "hmrc-period" as const, day: "2026-11-01", source: "https://www.trade-tariff.service.gov.uk/exchange_rates" };
  const record = ukVatRecord({ sale: "cs_uk_usd", store: "st_1", invoice: ukInvoice({ ...invoiceInput, currency: "USD", sterling: period })!, place: { kind: "uk", evidence: gb } })!;
  const later = at("2026-11-20T12:00:00Z");
  const half = ukVatAdjustment(record, { at: later, exVatCents: -500, vatCents: -100, reason: "refund" });
  assert.notEqual(half, null);
  const whole = ukVatAdjustment(half!, { at: later, exVatCents: -500, vatCents: -100, reason: "refund" });
  assert.notEqual(whole, null, "the second half is recorded");
  const q4 = ukReturn([whole!], { start: "2026-10-01", end: "2026-12-31", filedOn: "2027-01-03" })!;
  assert.deepEqual([q4.box1Pence, q4.box6Pence], [0, 0], "nothing left declared");
});

test("in another currency, the pence left always match what is left converted, so box 1 never drains (Claude 7 on #4574 @5554f02147)", () => {
  const period = { perPound: "1.3137", basis: "hmrc-period" as const, day: "2026-11-01", source: "https://www.trade-tariff.service.gov.uk/exchange_rates" };
  let record = ukVatRecord({ sale: "cs_uk_usd_drift", store: "st_1", invoice: ukInvoice({ ...invoiceInput, currency: "USD", sterling: period })!, place: { kind: "uk", evidence: gb } })!;
  const later = at("2026-11-20T12:00:00Z");
  let exLeft = 1000;
  let vatLeft = 200;
  for (let i = 0; i < 300; i += 1) {
    const next = ukVatAdjustment(record, { at: later, exVatCents: -5, vatCents: -1, reason: "refund" });
    if (!next) break;
    record = next;
    exLeft -= 5;
    vatLeft -= 1;
  }
  const q4 = ukReturn([record], { start: "2026-10-01", end: "2026-12-31", filedOn: "2027-01-03" })!;
  assert.deepEqual([q4.box1Pence, q4.box6Pence], [toPence(vatLeft, "1.3137"), toPence(exLeft, "1.3137")]);
});

test("the invoice currency is a store currency with hundredths, read as Stripe writes it (Claude 5 on #4574 @2dc6127da7, LEVE 2)", () => {
  const period = { perPound: "1.3", basis: "hmrc-period", day: "2026-11-01", source: "https://www.trade-tariff.service.gov.uk/exchange_rates" } as const;
  // Stripe writes currencies in lower case: read as the same currency, not refused after the charge.
  const lower = ukInvoice({ ...invoiceInput, currency: "usd", sterling: period });
  assert.ok(lower, "a lower-case currency reads");
  assert.equal(lower!.currency, "USD");
  assert.equal(ukInvoice({ ...invoiceInput, currency: "gbp" })!.vatSterlingPence, 200, "lower-case sterling is sterling");
  // ISO 4217 three-decimal currencies, a made-up code and a zero-decimal currency are never taken as hundredths.
  for (const currency of ["IQD", "LYD", "ABC", "JPY", "KWD", "iqd"]) {
    assert.equal(ukInvoice({ ...invoiceInput, currency, sterling: period }), null, currency);
  }
});
