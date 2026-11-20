/**
 * EU VAT under art. 9a, unit 12b (coordinator IVA-2, 13/11/2026): collecting the VAT, and the reverse charge for a
 * business, are each behind one reviewed constant that starts false (EU_VAT_COLLECT_REVIEWED). Until a reviewer sets
 * it, no EU sale is collected or reverse-charged, whatever record is passed. A business gets the reverse charge only
 * with a VAT number VIES answered "verified" for the same country the evidence places it in. Synthetic only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EU_VAT_COLLECT_REVIEWED, euCheckout } from "@/lib/eu-vat-checkout";
import type { EuVatRate } from "@/lib/eu-vat-amount";

const rates: EuVatRate[] = [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-13" }];
const de = { ip: "DE", billing: "DE" };
const record = (treatment: string, registration = "") => ({
  jurisdiction: "EU", treatment, implementedIn: "lib/eu-vat-checkout.ts", recordedOn: "2026-11-13", registration, evidence: "tests/eu-vat-collect-review.test.ts",
});
const collecting = [record("collect", "IE OSS, 2026-11-13, EU000000000")];
const verified = { vatNumber: "DE123456789", vies: "verified" };

test("the reviewed constant starts false", () => {
  assert.equal(EU_VAT_COLLECT_REVIEWED, false);
});

test("unreviewed, a complete collect record still collects nothing: the sale is refused", () => {
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting }), { kind: "refuse", reason: "review" });
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting, business: verified }), { kind: "refuse", reason: "review" });
  // Outside the EU and free products are not EU supplies for consideration and are unchanged.
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: { ip: "US", billing: "US" }, rates, records: collecting }), { kind: "outside", country: "US" });
  assert.deepEqual(euCheckout({ supply: "free", priceCents: 0, items: de, rates, records: collecting }), { kind: "free", country: "DE" });
});

test("reviewed, a consumer is collected on top as before", () => {
  assert.equal(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting, reviewed: true }).kind, "collect");
});

test("reviewed, a business with a VIES-verified number of the same country is reverse-charged, never collected", () => {
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting, reviewed: true, business: verified }),
    { kind: "reverse-charge", country: "DE", vatNumber: "DE123456789" });
  const gr = { ip: "GR", billing: "GR" };
  const grRates: EuVatRate[] = [{ country: "GR", basisPoints: 2400, source: "https://example.invalid/gr", readOn: "2026-11-13" }];
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: gr, rates: grRates, records: collecting, reviewed: true, business: { vatNumber: "EL123456789", vies: "verified" } }),
    { kind: "reverse-charge", country: "GR", vatNumber: "EL123456789" }, "Greece's VAT prefix is EL");
});

test("reviewed, any other business answer is refused, never reverse-charged nor collected from the business", () => {
  for (const business of [
    { vatNumber: "DE123456789", vies: "invalid" },
    { vatNumber: "DE123456789", vies: "unavailable" },
    { vatNumber: "DE123456789", vies: null },
    { vatNumber: "FR12345678901", vies: "verified" },
    { vatNumber: "de123456789", vies: "verified" },
    { vatNumber: "DE", vies: "verified" },
    { vatNumber: "DE12345678<script>", vies: "verified" },
    { vatNumber: 123, vies: "verified" },
    { vatNumber: "US123456789", vies: "verified" },
  ]) {
    assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting, reviewed: true, business }), { kind: "refuse", reason: "business" }, JSON.stringify(business));
  }
});

test("reviewed, a business still needs a complete EU record, an electronically supplied service and agreeing evidence", () => {
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, reviewed: true, business: verified }), { kind: "refuse", reason: "record" });
  assert.deepEqual(euCheckout({ supply: "goods", priceCents: 1000, items: de, rates, records: collecting, reviewed: true, business: verified }), { kind: "refuse", reason: "goods" });
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: { ip: "DE", billing: "FR" }, rates, records: collecting, reviewed: true, business: verified }), { kind: "refuse", reason: "place" });
});
