/**
 * EU VAT under Implementing Regulation 282/2011 art. 9a (docs/eu-vat-article-9a.md), part 2 of the build, units 1 and 2:
 *
 *   1. what each product a store sells is for EU VAT: an electronically supplied service (art. 7), a service delivered by
 *      a person (a live call), goods (art. 14a of the Directive), nothing sold (free), or unknown. Unknown never sells to
 *      an EU consumer: a product whose kind is not recognised, a bundle with a member not read, a paid product that
 *      delivers nothing the code knows.
 *   2. where the consumer belongs (arts. 24b(d), 24f): two items of evidence, each a country, that agree. Two that
 *      disagree, one missing, or one not a country are never a place: the EU sale is refused, never guessed. A country
 *      whose VAT territory is not the whole of it by its code alone is unknown too.
 *
 * Pure functions on synthetic products; nothing is read or written, no provider is called. Nothing here records a
 * treatment (DEEMED_SUPPLIER_RECORDS stays empty) or opens a sale.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EU_VAT_COUNTRIES, euSupplyOf, consumerPlace } from "@/lib/eu-vat-supply";
import { DEEMED_SUPPLIER_RECORDS, deemedSupplierReady } from "@/lib/deemed-supplier";

type P = Parameters<typeof euSupplyOf>[0];
const base: P = { priceCents: 1000, file: null, link: null, keys: null, course: null, podcast: null, recurring: null, call: null, callPackage: null, bundle: null, shipping: null, pwyw: null };

test("a file, a link, licence keys, a course, a private podcast and a membership are electronically supplied services", () => {
  const cases: Partial<P>[] = [
    { file: { name: "a.pdf" } as P["file"] },
    { link: "https://example.com/x" },
    { keys: { count: 1 } as unknown as P["keys"] },
    { course: { id: "c1" } as unknown as P["course"] },
    { podcast: { id: "p1" } as unknown as P["podcast"] },
    { recurring: { interval: "month" } as unknown as P["recurring"] },
  ];
  for (const over of cases) assert.equal(euSupplyOf({ ...base, ...over }), "ess", JSON.stringify(over));
});

test("a live call and a package of calls are delivered by a person, never taken for an electronically supplied service", () => {
  assert.equal(euSupplyOf({ ...base, call: { minutes: 30 } as unknown as P["call"] }), "human");
  assert.equal(euSupplyOf({ ...base, callPackage: { calls: 3 } as unknown as P["callPackage"] }), "human");
});

test("a product that ships is goods, whatever else it carries", () => {
  assert.equal(euSupplyOf({ ...base, shipping: { cents: 0, region: "custom", countries: ["US"] } as unknown as P["shipping"] }), "goods");
  assert.equal(euSupplyOf({ ...base, file: { name: "a.pdf" } as P["file"], shipping: { cents: 0, region: "custom", countries: ["US"] } as unknown as P["shipping"] }), "goods");
});

test("a free product with no pay-what-you-want price is not a supply for consideration", () => {
  assert.equal(euSupplyOf({ ...base, priceCents: 0, file: { name: "a.pdf" } as P["file"] }), "free");
  assert.equal(euSupplyOf({ ...base, priceCents: 0, file: { name: "a.pdf" } as P["file"], pwyw: { min: 0 } as unknown as P["pwyw"] }), "ess");
});

test("unknown never sells: a paid product that delivers nothing known, a price that is not a whole number, a bundle with a member not given", () => {
  assert.equal(euSupplyOf(base), "unknown");
  assert.equal(euSupplyOf({ ...base, priceCents: Number.NaN, file: { name: "a.pdf" } as P["file"] }), "unknown");
  assert.equal(euSupplyOf({ ...base, bundle: ["a", "b"] }), "unknown");
  assert.equal(euSupplyOf({ ...base, bundle: ["a", "b"] }, new Map([["a", { ...base, file: { name: "a.pdf" } as P["file"] }]])), "unknown");
});

test("a bundle is what its members are; mixed members are the strictest of them", () => {
  const digital = { ...base, file: { name: "a.pdf" } as P["file"] };
  const call = { ...base, call: { minutes: 30 } as unknown as P["call"] };
  const shipped = { ...base, shipping: { cents: 0, region: "custom", countries: ["US"] } as unknown as P["shipping"] };
  assert.equal(euSupplyOf({ ...base, bundle: ["a", "b"] }, new Map([["a", digital], ["b", digital]])), "ess");
  assert.equal(euSupplyOf({ ...base, bundle: ["a", "b"] }, new Map([["a", digital], ["b", call]])), "human");
  assert.equal(euSupplyOf({ ...base, bundle: ["a", "b"] }, new Map([["a", digital], ["b", shipped]])), "goods");
  assert.equal(euSupplyOf({ ...base, bundle: ["a", "b"] }, new Map([["a", digital], ["b", { ...base, bundle: ["a"] }]])), "unknown");
});

test("the EU VAT countries are the 27 Member States by their ISO codes", () => {
  assert.equal(EU_VAT_COUNTRIES.size, 27);
  for (const code of ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]) assert.ok(EU_VAT_COUNTRIES.has(code), code);
  for (const code of ["GB", "CH", "NO", "US", "BR", "EL"]) assert.ok(!EU_VAT_COUNTRIES.has(code), code);
});

test("two items that agree place the consumer; for an EU country they are kept as the evidence", () => {
  assert.deepEqual(consumerPlace({ ip: "DE", billing: "de" }), { kind: "eu", country: "DE", evidence: { ip: "DE", billing: "DE" } });
  assert.deepEqual(consumerPlace({ ip: "US", billing: "US" }), { kind: "outside", country: "US" });
});

test("items that disagree, a missing item or one that is not a country are never a place", () => {
  assert.deepEqual(consumerPlace({ ip: "DE", billing: "FR" }), { kind: "unknown", reason: "contradiction" });
  assert.deepEqual(consumerPlace({ ip: "DE", billing: "US" }), { kind: "unknown", reason: "contradiction" });
  assert.deepEqual(consumerPlace({ ip: "US", billing: "DE" }), { kind: "unknown", reason: "contradiction" });
  assert.deepEqual(consumerPlace({ ip: "DE", billing: null }), { kind: "unknown", reason: "missing" });
  assert.deepEqual(consumerPlace({ ip: "", billing: "DE" }), { kind: "unknown", reason: "missing" });
  assert.deepEqual(consumerPlace({ ip: "XX", billing: "XX" }), { kind: "unknown", reason: "not-a-country" });
  assert.deepEqual(consumerPlace({ ip: "D1", billing: "D1" }), { kind: "unknown", reason: "not-a-country" });
  assert.deepEqual(consumerPlace({ ip: "T1", billing: "T1" }), { kind: "unknown", reason: "not-a-country" });
});

test("a third item read after payment (the card's country) that disagrees is kept as a contradiction", () => {
  assert.deepEqual(consumerPlace({ ip: "DE", billing: "DE", card: "FR" }), { kind: "unknown", reason: "contradiction" });
  assert.deepEqual(consumerPlace({ ip: "DE", billing: "DE", card: "DE" }), { kind: "eu", country: "DE", evidence: { ip: "DE", billing: "DE", card: "DE" } });
});

test("a country whose VAT territory its code alone does not settle is unknown, never a Member State's rate", () => {
  // Spain's Canary Islands and Ceuta/Melilla, Monaco under France, and the like (Directive art. 6): by code alone, not settled.
  for (const code of ["ES", "MC", "EA", "IC"]) {
    const place = consumerPlace({ ip: code, billing: code });
    assert.deepEqual(place, { kind: "unknown", reason: "territory" }, code);
  }
});

test("nothing here records a treatment or opens a sale", () => {
  assert.equal(DEEMED_SUPPLIER_RECORDS.length, 0);
  assert.equal(deemedSupplierReady(), false);
});
