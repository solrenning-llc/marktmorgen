/**
 * 793 [IV3] unit 2, owner's decision OWNER-20261121-1529-ART9A-PENDING-DECISIONS, item 2 (b): a sale whose VAT the
 * Solrenning LLC collected shows, in the creator's list of sales, its own lines: the VAT collected for the tax office,
 * and the part of Stripe's processing fee that fell on that VAT, which the creator pays (Stripe charges its fee on the
 * whole amount the buyer paid, VAT included). Read only from what Stripe gives: the sale's VAT mark and the charge's
 * balance transaction. A sale without the mark shows nothing new; a fee Stripe has not given is "not known yet",
 * never 0.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type SaleVatLine, saleVatLine } from "@/lib/sale-vat-line";

const line = (value: unknown) => saleVatLine(value) as SaleVatLine | null;

function intent(meta: Record<string, string>, charge: unknown = chargeWith(370, "eur")) {
  return { object: "payment_intent", id: "pi_VatLine0000001", metadata: meta, latest_charge: charge };
}
function chargeWith(stripeFee: number, currency: string, extra: object[] = []) {
  return {
    object: "charge",
    id: "ch_VatLine0000001",
    amount: 11900,
    currency: "eur",
    balance_transaction: {
      object: "balance_transaction",
      id: "txn_VatLine000001",
      currency,
      fee_details: [{ type: "stripe_fee", amount: stripeFee, currency }, ...extra],
    },
  };
}

test("no VAT mark: no line at all", () => {
  assert.equal(saleVatLine(intent({ store: "shop" })), null);
  assert.equal(saleVatLine(null), null);
  assert.equal(saleVatLine({ object: "charge" }), null);
});

test("EU VAT: the VAT and Stripe's fee on it, in proportion to the VAT in what the buyer paid", () => {
  // €100.00 + €19.00 VAT = €119.00; Stripe's fee €3.70 on the €119.00, so €0.59 of it fell on the VAT (370 × 1900 / 11900).
  assert.deepEqual(saleVatLine(intent({ eu_vat: "DE:1900:1900" })), {
    country: "DE", basisPoints: 1900, vatCents: 1900, currency: "eur",
    stripeFeeOnVat: { cents: 59, currency: "eur" },
  });
});

test("only Stripe's own fee: the platform's fee (which carries the VAT itself) is never counted", () => {
  const read = line(intent({ eu_vat: "DE:1900:1900" }, chargeWith(370, "eur", [{ type: "application_fee", amount: 2020, currency: "eur" }])));
  assert.deepEqual(read?.stripeFeeOnVat, { cents: 59, currency: "eur" });
});

test("UK VAT, and a fee settled in another currency is shown in that currency", () => {
  assert.deepEqual(saleVatLine(intent({ uk_vat: "GB:2000:1900" }, chargeWith(400, "usd"))), {
    country: "GB", basisPoints: 2000, vatCents: 1900, currency: "eur",
    stripeFeeOnVat: { cents: 64, currency: "usd" },
  });
});

test("a fee Stripe has not given yet is not known, never 0", () => {
  for (const charge of [
    "ch_VatLine0000001",
    { ...chargeWith(370, "eur"), balance_transaction: null },
    { ...chargeWith(370, "eur"), balance_transaction: "txn_VatLine000001" },
    { ...chargeWith(370, "eur"), amount: 0 },
    { ...chargeWith(370, "eur"), balance_transaction: { object: "balance_transaction", currency: "eur", fee_details: "x" } },
    { ...chargeWith(370, "eur"), balance_transaction: { object: "balance_transaction", currency: "eur", fee_details: [] } },
    chargeWith(-5, "eur"),
    chargeWith(Number.NaN, "eur"),
  ]) {
    const read = line(intent({ eu_vat: "DE:1900:1900" }, charge));
    assert.equal(read?.vatCents, 1900, JSON.stringify(charge));
    assert.equal(read?.stripeFeeOnVat, "unknown", JSON.stringify(charge));
  }
});

test("a mark that cannot be read is shown as unreadable, never as no VAT", () => {
  const metas: Record<string, string>[] = [{ eu_vat: "" }, { eu_vat: "DE:19:x" }, { uk_vat: "GB:2000" }, { eu_vat: "de:1900:1900" }, { eu_vat: "DE:1900:1900", uk_vat: "GB:2000:1900" }];
  for (const meta of metas) {
    assert.equal(saleVatLine(intent(meta)), "unreadable", JSON.stringify(meta));
  }
});
