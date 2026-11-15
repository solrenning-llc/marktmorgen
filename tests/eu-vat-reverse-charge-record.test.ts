/**
 * EU VAT under art. 9a, unit 1 (IVA, 14/11/2026): a sale reverse-charged to a business keeps, whole or none, the proof
 * that the buyer was a business (Regulation 282/2011 art. 18(1)(a): VIES's "valid" at the sale, the name and address
 * given) with the two items of location evidence and its invoice number; a collected sale whose buyer gave a number
 * VIES did not confirm keeps VIES's answer on its art. 63c record. Synthetic only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { euReverseChargeRecord, euVatAdjustment, euVatRecord } from "@/lib/eu-vat-record";
import type { ViesAnswer } from "@/lib/eu-vat-vies";

const at = Math.floor(Date.parse("2026-11-14T12:00:00Z") / 1000);
const place = { kind: "eu" as const, country: "DE", evidence: { ip: "DE", billing: "DE" } };
const valid: ViesAnswer = {
  state: "valid", country: "DE", number: "123456789", askedAt: "2026-11-14T11:59:00.000Z", viesDate: "2026-11-14T11:59:00.000Z", error: null,
  name: "BEISPIEL GMBH", address: null, requestIdentifier: null,
};
const sale = {
  sale: "cs_test_1", store: "st_1", service: "Download", at, currency: "eur", amountCents: 1000, place, vatNumber: "DE123456789", vies: valid,
  customer: { name: "Beispiel GmbH", address: "Beispielweg 1, 10115 Berlin" }, invoice: "MM-EU-2026-000002",
};

test("a reverse-charged sale keeps the number, VIES's valid answer, the name and address, the evidence and the invoice", () => {
  assert.deepEqual(euReverseChargeRecord(sale), {
    v: 1, kind: "reverse-charge", sale: "cs_test_1", store: "st_1", memberState: "DE", service: "Download", date: "2026-11-14", currency: "EUR",
    amountCents: 1000, vatNumber: "DE123456789", vies: valid, customer: sale.customer, location: { ip: "DE", billing: "DE" }, invoice: "MM-EU-2026-000002",
  });
});

test("without VIES's valid answer for that very number and country, or without a name, an address or an invoice, nothing is recorded", () => {
  for (const change of [
    { vies: { ...valid, state: "unavailable" as const } }, { vies: { ...valid, country: "FR" } }, { vatNumber: "DE999999999" },
    { customer: { name: "", address: "x" } }, { customer: { name: "x", address: "" } }, { invoice: "" }, { amountCents: 0 },
    { place: { kind: "outside" as const, country: "US" } }, { currency: "euro" }, { at: 0 },
  ]) {
    assert.equal(euReverseChargeRecord({ ...sale, ...change } as typeof sale), null, JSON.stringify(change));
  }
});

test("a collected sale keeps on its record what VIES said about a number it did not confirm", () => {
  const unavailable: ViesAnswer = { ...valid, state: "unavailable", error: "MS_UNAVAILABLE", name: null };
  const base = {
    sale: "cs_test_2", store: "st_1", supply: "ess" as const, service: "Download", at, currency: "eur",
    vat: { priceCents: 1000, vatCents: 190, totalCents: 1190, basisPoints: 1900, country: "DE" }, place, payments: [{ at, cents: 1190 }], customerName: null,
  };
  assert.deepEqual(euVatRecord({ ...base, vies: unavailable })?.vies, unavailable);
  assert.equal("vies" in (euVatRecord(base) ?? {}), false, "no answer, no field");
});

test("an adjustment never comes before its sale, carries the rate's VAT on its amount and leaves no VAT on nothing", () => {
  const record = euVatRecord({
    sale: "cs_test_3", store: "st_1", supply: "ess", service: "Download", at, currency: "eur",
    vat: { priceCents: 1000, vatCents: 190, totalCents: 1190, basisPoints: 1900, country: "DE" }, place, payments: [{ at, cents: 1190 }], customerName: null,
  })!;
  const later = at + 86_400;
  assert.notEqual(euVatAdjustment(record, { at: later, taxableCents: -500, vatCents: -95, reason: "refund" }), null);
  assert.notEqual(euVatAdjustment(record, { at: later, taxableCents: -333, vatCents: -64, reason: "refund" }), null, "63.27 rounds to 63; one cent either way is the proportion's rounding");
  assert.equal(euVatAdjustment(record, { at: at - 86_400, taxableCents: -500, vatCents: -95, reason: "refund" }), null, "before the sale");
  assert.equal(euVatAdjustment(record, { at: later, taxableCents: -1, vatCents: -190, reason: "refund" }), null, "VAT out of proportion");
  assert.equal(euVatAdjustment(record, { at: later, taxableCents: -1000, vatCents: -100, reason: "refund" }), null, "a full refund leaves no VAT behind");
  assert.equal(euVatAdjustment(record, { at: later, taxableCents: -500, vatCents: 95, reason: "refund" }), null, "signs disagree");
});
