/**
 * EU VAT under art. 9a, part 2 of the build, unit 5a: what a checkout does with one sale before it opens
 * (docs/eu-vat-article-9a.md, "The code that would be needed", points 1 to 3). Pure; nothing opens here.
 *
 *   - a consumer placed outside the EU: no EU VAT;
 *   - a consumer whose place is unknown (missing, contradicting, not a country, a territory the code does not settle):
 *     refused, since nothing shows the consumer is outside the EU;
 *   - an EU consumer: a free product carries no VAT; an electronically supplied service with a sourced rate is
 *     collected on top of the price; goods, a service delivered by a person (until a legal decision records it) and
 *     anything unknown are refused, and so is a service with no sourced rate.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { euCheckout } from "@/lib/eu-vat-checkout";
import type { EuVatRate } from "@/lib/eu-vat-amount";

const rates: EuVatRate[] = [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-13" }];
const de = { ip: "DE", billing: "DE" };
const record = (treatment: string, registration = "") => ({
  jurisdiction: "EU", treatment, implementedIn: "lib/eu-vat-checkout.ts", recordedOn: "2026-11-13", registration, evidence: "tests/eu-vat-checkout.test.ts",
});
const collecting = [record("collect", "IE OSS, 2026-11-13, EU000000000")];

test("a consumer outside the EU carries no EU VAT", () => {
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: { ip: "US", billing: "US" }, rates }), { kind: "outside", country: "US" });
  assert.deepEqual(euCheckout({ supply: "goods", priceCents: 1000, items: { ip: "BR", billing: "BR" }, rates }), { kind: "outside", country: "BR" });
});

test("a consumer whose place is unknown is refused", () => {
  for (const items of [{ ip: "DE", billing: "US" }, { ip: "DE", billing: null }, { ip: "XX", billing: "XX" }, { ip: "ES", billing: "ES" }]) {
    const answer = euCheckout({ supply: "ess", priceCents: 1000, items, rates });
    assert.equal(answer.kind, "refuse", JSON.stringify(items));
    assert.equal((answer as { reason: string }).reason, "place");
  }
});

test("an EU consumer: an electronically supplied service with a sourced rate is collected on top", () => {
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting }), {
    kind: "collect",
    vat: { priceCents: 1000, vatCents: 190, totalCents: 1190, basisPoints: 1900, country: "DE" },
    place: { kind: "eu", country: "DE", evidence: de },
  });
});

test("an EU consumer: a free product carries no VAT", () => {
  assert.deepEqual(euCheckout({ supply: "free", priceCents: 0, items: de, rates }), { kind: "free", country: "DE" });
});

test("an EU consumer: goods, a person's service, anything unknown and a country with no sourced rate are refused", () => {
  assert.deepEqual(euCheckout({ supply: "goods", priceCents: 1000, items: de, rates }), { kind: "refuse", reason: "goods" });
  assert.deepEqual(euCheckout({ supply: "human", priceCents: 1000, items: de, rates }), { kind: "refuse", reason: "human" });
  assert.deepEqual(euCheckout({ supply: "unknown", priceCents: 1000, items: de, rates }), { kind: "refuse", reason: "supply" });
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: { ip: "FR", billing: "FR" }, rates, records: collecting }), { kind: "refuse", reason: "rate" });
  // The real records are empty: every EU sale is refused today. A collect record with no sourced rate is refused too
  // (the real table's own values and review date are held by tests/eu-vat-rates-table.test.ts).
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de }), { kind: "refuse", reason: "record" });
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates: [], records: collecting }), { kind: "refuse", reason: "rate" });
});

/**
 * Unit 10b: the EU treatment comes from the EU record in lib/deemed-supplier.ts (docs/art9a-sources-and-build-spec,
 * 2.4: with no application fee there is no way today to move the VAT to the LLC, so the only buildable record is
 * "refuse-consumers"). An EU consumer of a paid electronically supplied service is collected only under a complete
 * "collect" record; with no complete EU record, or under "refuse-consumers", that sale is refused. A consumer
 * outside the EU and a free product are not EU supplies for consideration and are unchanged.
 */
test("10b: an EU sale is refused while there is no complete EU record (the real list is empty)", () => {
  for (const records of [undefined, [], [record("collect")], [{ ...record("collect", "x"), recordedOn: "2026-13-01" }], "nonsense", [record("refuse-consumers"), record("collect", "x")]]) {
    assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records }), { kind: "refuse", reason: "record" }, JSON.stringify(records));
  }
});

test("10b: under refuse-consumers an EU consumer of a paid service is refused, while outside and free are unchanged", () => {
  const records = [record("refuse-consumers")];
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records }), { kind: "refuse", reason: "treatment" });
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: { ip: "US", billing: "US" }, rates, records }), { kind: "outside", country: "US" });
  assert.deepEqual(euCheckout({ supply: "free", priceCents: 0, items: de, rates, records }), { kind: "free", country: "DE" });
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: { ip: "DE", billing: "US" }, rates, records }), { kind: "refuse", reason: "place" });
});

test("10b: only a complete collect record, with its registration, collects", () => {
  assert.equal(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting }).kind, "collect");
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: { ip: "FR", billing: "FR" }, rates, records: collecting }), { kind: "refuse", reason: "rate" });
  assert.deepEqual(euCheckout({ supply: "goods", priceCents: 1000, items: de, rates, records: collecting }), { kind: "refuse", reason: "goods" });
});
