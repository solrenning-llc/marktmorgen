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
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de, rates }), {
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
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: { ip: "FR", billing: "FR" }, rates }), { kind: "refuse", reason: "rate" });
  // The real table is empty: every EU sale is refused today.
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: de }), { kind: "refuse", reason: "rate" });
});
