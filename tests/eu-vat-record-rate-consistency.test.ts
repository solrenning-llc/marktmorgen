/**
 * A VAT record whose rate and amount disagree is never made (Codex U-20261120-2120, HIGH, lib/eu-vat-record.ts
 * euVatRecord): it checked only that total = price + VAT, so 19% with one cent of VAT, a 0% rate, 27% carrying the 19%
 * amount, or a rate above any EU rate all made a record, which ossReturn then declares under the wrong rate.
 * Codex U's test, with two more controls; a pure function, synthetic sale.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { euVatRecord } from "@/lib/eu-vat-record";

const base = {
  sale: "cs_synthetic_rate_consistency",
  store: "0123456789abcdef0123456789abcdef",
  supply: "ess" as const,
  service: "Digital download",
  at: 1_794_000_000,
  currency: "eur",
  vat: { priceCents: 1000, vatCents: 190, totalCents: 1190, basisPoints: 1900, country: "DE" },
  place: { kind: "eu" as const, country: "DE", evidence: { ip: "DE", billing: "DE" } },
  payments: [{ at: 1_794_000_000, cents: 1190 }],
  customerName: null,
};

const withVat = (basisPoints: number, vatCents: number) => ({
  ...base,
  vat: { ...base.vat, basisPoints, vatCents, totalCents: 1000 + vatCents },
  payments: [{ at: base.at, cents: 1000 + vatCents }],
});

test("a VAT record refuses a rate and amount that do not agree", () => {
  assert.notEqual(euVatRecord(base), null, "valid 19% control");
  assert.equal(euVatRecord(withVat(1900, 1)), null, "19% cannot record one cent");
  assert.equal(euVatRecord(withVat(0, 0)), null, "zero is not a sourced standard rate");
  assert.equal(euVatRecord(withVat(2700, 190)), null, "27% cannot carry the 19% amount");
  assert.equal(euVatRecord(withVat(100000, 190)), null, "an impossible rate is refused");
  assert.equal(euVatRecord(withVat(1900, 191)), null, "one cent over the half-up amount is refused");
  assert.notEqual(euVatRecord(withVat(2700, 270)), null, "27% with its own amount is kept");
  assert.notEqual(euVatRecord({ ...withVat(1900, 0), vat: { ...base.vat, priceCents: 2, vatCents: 0, totalCents: 2 }, payments: [{ at: base.at, cents: 2 }] }), null, "two cents at 19% round to no VAT and are kept");
});
