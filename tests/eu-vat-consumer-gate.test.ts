/**
 * EU VAT under art. 9a, opening path (C2-20261113-1320-ABRIR-1, 2b and 2d): consumerGate (lib/eu-vat-gate.ts) is the
 * question a checkout asks before any charge while neither the EU nor the UK has a "collect" record. A paid product
 * supplied electronically, a physical one, or one whose kind does not read, is refused when EITHER the IP's country
 * or the billing country the buyer chose is in the EU (or an EU place a code names apart, or Monaco) or the UK (or the
 * Isle of Man); with neither there it goes on when the billing country was given, and asks for it when it was not. A
 * free product and a live service go on wherever the buyer is. Pure; synthetic products and headers only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BILLING_COUNTRY_NEEDED, EU_UK_REFUSED, REFUSED_PLACES, consumerGate } from "@/lib/eu-vat-gate";
import { BILLING_COUNTRY_FIELD } from "@/lib/eu-vat-evidence";
import { EU_VAT_COUNTRIES } from "@/lib/eu-vat-supply";

const download = { priceCents: 2900, file: "vault/x/y/z.pdf", link: null, keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null };
const course = { ...download, file: null, course: "c1" };
const call = { ...download, file: null, call: { minutes: 30 } };
const goods = { ...download, file: null, shipping: { countries: ["US"] } };
const free = { ...download, priceCents: 0 };
const unknownKind = { ...download, file: null };
const at = (ip: string | null, billing: string | null) => ({
  headers: new Headers(ip === null ? {} : { "x-vercel-ip-country": ip }),
  form: new URLSearchParams(billing === null ? {} : { [BILLING_COUNTRY_FIELD]: billing }),
});
const refused = { ok: false, reason: "refused", message: EU_UK_REFUSED };
const ask = { ok: false, reason: "billing", message: BILLING_COUNTRY_NEEDED };

test("the EU: refused by its IP, by its billing country, or both", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("DE", "DE") }), refused);
  assert.deepEqual(consumerGate({ product: download, ...at("FR", null) }), refused);
  assert.deepEqual(consumerGate({ product: course, ...at(null, "IT") }), refused);
  for (const member of EU_VAT_COUNTRIES) assert.deepEqual(consumerGate({ product: download, ...at("US", member) }), refused, member);
});

test("the UK and the Isle of Man: refused like the EU", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("GB", "GB") }), refused);
  assert.deepEqual(consumerGate({ product: download, ...at("US", "GB") }), refused);
  assert.deepEqual(consumerGate({ product: download, ...at("IM", "US") }), refused);
});

test("EU places a code names apart, and Monaco: refused", () => {
  for (const place of ["GF", "GP", "MQ", "RE", "YT", "MF", "AX", "MC"]) {
    assert.equal(REFUSED_PLACES.has(place), true, place);
    assert.deepEqual(consumerGate({ product: download, ...at(place, "US") }), refused, place);
  }
});

test("outside: goes on with the IP and the billing country both outside, or the IP missing", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("US", "US") }), { ok: true });
  assert.deepEqual(consumerGate({ product: download, ...at("BR", "CA") }), { ok: true });
  assert.deepEqual(consumerGate({ product: download, ...at(null, "us") }), { ok: true });
  // Norway, Switzerland, Jersey and Guernsey are outside both the EU and the UK VAT areas.
  for (const place of ["NO", "CH", "JE", "GG"]) assert.deepEqual(consumerGate({ product: download, ...at(place, place) }), { ok: true }, place);
});

test("a VPN either way is refused: an IP outside with an EU billing country, and an EU IP with one outside", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("US", "NL") }), refused);
  assert.deepEqual(consumerGate({ product: download, ...at("NL", "US") }), refused);
});

test("no billing country: asked for, unless the IP already places the buyer where the sale is refused", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("US", null) }), ask);
  assert.deepEqual(consumerGate({ product: download, ...at(null, null) }), ask);
  assert.deepEqual(consumerGate({ product: download, ...at("US", "") }), ask);
  assert.deepEqual(consumerGate({ product: download, ...at("US", "XX") }), ask, "a code that is no country");
  assert.deepEqual(consumerGate({ product: download, ...at("US", "United States") }), ask, "a name, not a code");
  assert.deepEqual(consumerGate({ product: download, ...at("DE", null) }), refused);
});

test("an IP code that is no country counts as missing", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("XX", "US") }), { ok: true });
  assert.deepEqual(consumerGate({ product: download, ...at("T1", null) }), ask);
});

test("a free product goes on wherever the buyer is, with or without a billing country", () => {
  assert.deepEqual(consumerGate({ product: free, ...at("DE", "DE") }), { ok: true });
  assert.deepEqual(consumerGate({ product: free, ...at("GB", null) }), { ok: true });
});

test("a live service goes on; a bundle goes on as one only when every member is one", () => {
  assert.deepEqual(consumerGate({ product: call, ...at("DE", "DE") }), { ok: true });
  const members = new Map([["c", call], ["d", download], ["c2", { ...call, priceCents: 0 }]]);
  assert.deepEqual(consumerGate({ product: { ...download, file: null, bundle: ["c", "c2"] }, members, ...at("DE", "DE") }), { ok: true });
  assert.deepEqual(consumerGate({ product: { ...download, file: null, bundle: ["c", "d"] }, members, ...at("DE", "DE") }), refused);
});

test("physical goods and a product whose kind does not read: refused like a download", () => {
  assert.deepEqual(consumerGate({ product: goods, ...at("DE", "DE") }), refused);
  assert.deepEqual(consumerGate({ product: goods, ...at("US", "US") }), { ok: true });
  assert.deepEqual(consumerGate({ product: unknownKind, ...at("GB", "GB") }), refused);
  assert.deepEqual(consumerGate({ product: unknownKind, ...at("US", null) }), ask);
});

test("the sentences are plain and say nothing was charged", () => {
  assert.match(EU_UK_REFUSED, /European Union or the United Kingdom/);
  assert.match(EU_UK_REFUSED, /Nothing was charged\.$/);
  assert.equal(BILLING_COUNTRY_NEEDED, "Choose the country you're buying from, then try again.");
});
