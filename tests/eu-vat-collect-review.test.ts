/**
 * EU VAT under art. 9a, unit 12b (coordinator IVA-2, 13/11/2026), with unit 1 (IVA, 14/11/2026): collecting the VAT,
 * and the reverse charge for a business, are each behind one reviewed constant that starts false
 * (EU_VAT_COLLECT_REVIEWED). Until a reviewer sets it, no EU sale is collected or reverse-charged, whatever record is
 * passed. A business gets the reverse charge only with VIES's own "valid" answer (lib/eu-vat-vies.ts), fresh, for the
 * number typed and the country the evidence places it in; any other answer (invalid, MS_UNAVAILABLE, a timeout, an
 * old answer, another country) charges the consumer's VAT and keeps that answer with the sale (VIES FAQ resp20, read
 * 14/11/2026: "you should not exempt the supply but should charge VAT"). Synthetic only.
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
const now = new Date("2026-11-14T12:00:00.000Z");
const answer = (state: string, country = "DE", number = "123456789", askedAt = "2026-11-14T11:59:00.000Z", disclosed = true) => ({
  state, country, number, askedAt, viesDate: askedAt, error: state === "unavailable" ? "MS_UNAVAILABLE" : null,
  name: disclosed ? "BEISPIEL GMBH" : null, address: disclosed ? "BEISPIELWEG 1, 10115 BERLIN" : null, requestIdentifier: null,
});
const verified = { vatNumber: "DE123456789", vies: answer("valid") };

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

test("reviewed, a business whose number VIES answered valid, fresh, for the same country is reverse-charged, never collected", () => {
  const rc = euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting, reviewed: true, business: verified, now });
  assert.equal(rc.kind, "reverse-charge");
  assert.equal((rc as { vatNumber: string }).vatNumber, "DE123456789");
  assert.deepEqual((rc as { vies: unknown }).vies, verified.vies, "VIES's answer at the sale is kept");
  const gr = { ip: "GR", billing: "GR" };
  const grRates: EuVatRate[] = [{ country: "GR", basisPoints: 2400, source: "https://example.invalid/gr", readOn: "2026-11-13" }];
  const greek = euCheckout({ supply: "ess", priceCents: 1000, items: gr, rates: grRates, records: collecting, reviewed: true, business: { vatNumber: "EL 123 456 789", vies: answer("valid", "GR") }, now });
  assert.equal(greek.kind, "reverse-charge");
  assert.equal((greek as { vatNumber: string }).vatNumber, "EL123456789", "Greece's VAT prefix is EL");
});

test("reviewed, every other business answer charges the consumer's VAT on top and keeps what VIES said", () => {
  for (const business of [
    { vatNumber: "DE123456789", vies: answer("invalid") },
    { vatNumber: "DE123456789", vies: answer("unavailable") },
    { vatNumber: "DE123456789", vies: answer("valid", "DE", "123456789", "2026-11-14T10:00:00.000Z") },
    { vatNumber: "DE123456789", vies: answer("valid", "DE", "999999999") },
    { vatNumber: "FR12345678901", vies: answer("valid", "FR", "12345678901") },
    { vatNumber: "DE123456789", vies: "verified" },
    { vatNumber: "DE123456789", vies: null },
    { vatNumber: "DE12345678<script>", vies: answer("valid") },
    { vatNumber: "DE", vies: answer("valid") },
    // Art. 18(1)(a): VIES must confirm the number "and the associated name and address"; a Member State that does
    // not disclose them (VIES FAQ resp17) leaves the business unconfirmed, so its VAT is charged.
    { vatNumber: "DE123456789", vies: answer("valid", "DE", "123456789", "2026-11-14T11:59:00.000Z", false) },
    { vatNumber: "DE123456789", vies: { ...answer("valid"), address: null } },
    { vatNumber: 123, vies: answer("valid") },
    { vatNumber: "US123456789", vies: answer("valid", "US") },
  ]) {
    const sale = euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting, reviewed: true, business, now });
    assert.equal(sale.kind, "collect", JSON.stringify(business));
    const collected = sale as { vat: { vatCents: number; totalCents: number }; vies: unknown };
    assert.equal(collected.vat.vatCents, 190);
    assert.equal(collected.vat.totalCents, 1190);
    const kept = business.vies && typeof business.vies === "object" ? business.vies : null;
    assert.deepEqual(collected.vies, kept, "the answer VIES gave is kept with the sale, or none when there was none");
  }
});

test("under refuse-consumers, a VIES-confirmed business is still reverse-charged: the record refuses consumers, not businesses", () => {
  // Explicit decision (review of 15/11/2026, finding 7): art. 196 makes the business liable, so no OSS supply is made;
  // in practice the reviewed switch (lib/vat-registrations.ts) still needs the OSS registration before anything runs.
  const refusing = [record("refuse-consumers")];
  assert.equal(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: refusing, reviewed: true, business: verified, now }).kind, "reverse-charge");
});

test("a moment that is not one never throws: the sale is refused", () => {
  for (const bad of [new Date(Number.NaN), new Date(8.64e15 + 1)]) {
    const sale = euCheckout({ supply: "ess", priceCents: 1000, items: de, records: collecting, reviewed: true, now: bad });
    assert.equal(sale.kind, "refuse", String(bad));
    assert.equal(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting, reviewed: true, business: verified, now: bad }).kind, "refuse");
  }
});

test("a business charged VAT still needs the collect treatment: under refuse-consumers it is refused, never sold untaxed", () => {
  const refusing = [record("refuse-consumers")];
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: refusing, reviewed: true, business: { vatNumber: "DE123456789", vies: answer("unavailable") }, now }),
    { kind: "refuse", reason: "treatment" });
});

test("past the official table's review date no EU sale is collected: refused as rates-expired", () => {
  assert.equal(euCheckout({ supply: "ess", priceCents: 1000, items: de, records: collecting, reviewed: true, now }).kind, "collect");
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, records: collecting, reviewed: true, now: new Date("2027-01-01T00:00:00.000Z") }),
    { kind: "refuse", reason: "rates-expired" });
  // A business answered "unavailable" is charged VAT, so the expired table refuses it too.
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, records: collecting, reviewed: true, now: new Date("2027-01-01T00:00:00.000Z"), business: { vatNumber: "DE123456789", vies: answer("unavailable", "DE", "123456789", "2026-12-31T23:59:00.000Z") } }),
    { kind: "refuse", reason: "rates-expired" });
});

test("reviewed, a business still needs a complete EU record, an electronically supplied service and agreeing evidence", () => {
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, reviewed: true, business: verified, now }), { kind: "refuse", reason: "record" });
  assert.deepEqual(euCheckout({ supply: "goods", priceCents: 1000, items: de, rates, records: collecting, reviewed: true, business: verified, now }), { kind: "refuse", reason: "goods" });
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: { ip: "DE", billing: "FR" }, rates, records: collecting, reviewed: true, business: verified, now }), { kind: "refuse", reason: "place" });
});
