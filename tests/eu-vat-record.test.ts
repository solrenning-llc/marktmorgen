/**
 * EU VAT under art. 9a, part 2 of the build, unit 4a: the record Implementing Regulation 282/2011 art. 63c asks of each
 * supply under the non-Union scheme, made whole or not at all (docs/eu-vat-article-9a.md, "What follows", point 4):
 * the Member State of consumption, the type of service, the date, the taxable amount and its currency, the VAT rate,
 * the VAT amount and its currency, each payment's date and amount, the customer's name where known, and the
 * information used to place the customer. A sale missing any of them makes no record (null), so it can never be taken
 * as recorded. Later increases or reductions (a refund) are their own entries on the same sale. Synthetic only;
 * nothing is stored here.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EU_VAT_RECORD_VERSION, euVatRecord, euVatAdjustment } from "@/lib/eu-vat-record";

const sale = {
  sale: "cs_test_EuVatRecord0001",
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

test("a whole sale makes one record with every art. 63c field", () => {
  const record = euVatRecord(sale);
  assert.deepEqual(record, {
    v: EU_VAT_RECORD_VERSION,
    sale: sale.sale,
    store: sale.store,
    memberState: "DE",
    service: "Digital download",
    supply: "ess",
    date: "2026-11-06",
    currency: "EUR",
    taxableCents: 1000,
    rateBasisPoints: 1900,
    vatCents: 190,
    payments: [{ date: "2026-11-06", cents: 1190 }],
    customerName: null,
    location: { ip: "DE", billing: "DE" },
    adjustments: [],
  });
});

test("a sale missing any field, or whose parts disagree, makes no record", () => {
  const broken = [
    { ...sale, sale: "" },
    { ...sale, store: "" },
    { ...sale, service: "" },
    { ...sale, supply: "unknown" as never },
    { ...sale, supply: "goods" as never },
    { ...sale, currency: "euro" },
    { ...sale, at: Number.NaN },
    { ...sale, vat: null as never },
    { ...sale, vat: { ...sale.vat, totalCents: 1191 } },
    { ...sale, vat: { ...sale.vat, country: "FR" } },
    { ...sale, place: { kind: "unknown", reason: "contradiction" } as never },
    { ...sale, place: { kind: "outside", country: "US" } as never },
    { ...sale, payments: [] },
    { ...sale, payments: [{ at: 1_794_000_000, cents: 1189 }] },
  ];
  for (const one of broken) assert.equal(euVatRecord(one), null, JSON.stringify(one).slice(0, 120));
});

test("a refund is an adjustment entry on the same record, never a rewrite of the sale", () => {
  const record = euVatRecord(sale)!;
  const refunded = euVatAdjustment(record, { at: 1_794_086_400, taxableCents: -1000, vatCents: -190, reason: "refund" });
  assert.ok(refunded);
  assert.equal(refunded.taxableCents, 1000);
  assert.equal(refunded.vatCents, 190);
  assert.deepEqual(refunded.adjustments, [{ date: "2026-11-07", taxableCents: -1000, vatCents: -190, reason: "refund" }]);
  // Never more taken back than was charged, and never an adjustment with no amount or no reason.
  assert.equal(euVatAdjustment(refunded, { at: 1_794_086_400, taxableCents: -1, vatCents: 0, reason: "refund" }), null);
  assert.equal(euVatAdjustment(record, { at: 1_794_086_400, taxableCents: 0, vatCents: 0, reason: "refund" }), null);
  assert.equal(euVatAdjustment(record, { at: 1_794_086_400, taxableCents: -100, vatCents: -19, reason: "" }), null);
});
