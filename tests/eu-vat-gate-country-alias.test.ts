/**
 * EU VAT under art. 9a, Codex X3 MEDIUM on #4820 @0a7131ee90: consumerGate took any two capital letters outside a short
 * list of user-assigned codes for a country, and REFUSED_PLACES names the United Kingdom only as GB. So a paid checkout
 * sent with billing_country=UK (or uk, or " uk ") and a US IP went on, escaping the UK refusal. The gate now reads the
 * aliases UK (for GB) and EL (Greece's VAT prefix, for GR) before REFUSED_PLACES, and a billing country is given only
 * when it is one the billing field offers (lib/shipping.ts SHIP_COUNTRIES): any other code asks for the country, never
 * goes on. Pure; synthetic products and headers only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BILLING_COUNTRY_NEEDED, EU_UK_REFUSED, consumerGate } from "@/lib/eu-vat-gate";
import { BILLING_COUNTRY_FIELD } from "@/lib/eu-vat-evidence";
import { SHIP_COUNTRIES } from "@/lib/shipping";

const download = { priceCents: 2900, file: "vault/x/y/z.pdf", link: null, keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null };
const course = { ...download, file: null, course: "c1" };
const at = (ip: string | null, billing: string | null) => ({
  headers: new Headers(ip === null ? {} : { "x-vercel-ip-country": ip }),
  form: new URLSearchParams(billing === null ? {} : { [BILLING_COUNTRY_FIELD]: billing }),
});
const refused = { ok: false, reason: "refused", message: EU_UK_REFUSED };
const ask = { ok: false, reason: "billing", message: BILLING_COUNTRY_NEEDED };

test("a paid product, a US IP and billing_country=UK: refused like GB", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("US", "GB") }), refused);
  assert.deepEqual(consumerGate({ product: download, ...at("US", "UK") }), refused);
  assert.deepEqual(consumerGate({ product: course, ...at("US", "UK") }), refused);
  assert.deepEqual(consumerGate({ product: download, ...at(null, "UK") }), refused);
});

test("uk in lower case and with spaces: the same refusal", () => {
  for (const billing of ["uk", " uk ", "Uk", "  UK\t"]) assert.deepEqual(consumerGate({ product: download, ...at("US", billing) }), refused, JSON.stringify(billing));
});

test("an IP country sent as UK is refused too", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("UK", "US") }), refused);
});

test("EL, Greece's VAT prefix, is refused as Greece, never let through", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("US", "EL") }), refused);
  assert.deepEqual(consumerGate({ product: download, ...at("US", "el") }), refused);
});

test("a code the billing field does not offer asks for the country, never goes on", () => {
  for (const code of ["ZZ", "XX", "QZ", "AA", "EU", "UN", "XA", "OO", "JA"]) {
    assert.equal(SHIP_COUNTRIES.includes(code), false, code);
    assert.deepEqual(consumerGate({ product: download, ...at("US", code) }), ask, code);
  }
  for (const raw of ["USA", "U", "1", "U.S.", "United States"]) assert.deepEqual(consumerGate({ product: download, ...at("US", raw) }), ask, raw);
});

test("US still goes on, as before; Kosovo, which the field offers, still goes on", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("US", "US") }), { ok: true });
  assert.deepEqual(consumerGate({ product: download, ...at(null, "us") }), { ok: true });
  assert.deepEqual(consumerGate({ product: download, ...at("US", "XK") }), { ok: true });
});

test("every country the billing field offers either goes on or is refused, never asked for again", () => {
  for (const code of SHIP_COUNTRIES) {
    const answer = consumerGate({ product: download, ...at("US", code) });
    assert.notDeepEqual(answer, ask, code);
  }
});
