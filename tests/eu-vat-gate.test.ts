/**
 * EU VAT under art. 9a, part 2 of the build, unit 10c: the one call a checkout route makes before it opens a session
 * (lib/eu-vat-gate.ts). It reads the two items of location evidence the request carries (lib/eu-vat-evidence.ts), what
 * the product is (lib/eu-vat-supply.ts) and the EU record's treatment (lib/eu-vat-checkout.ts), and answers either
 * "go on" (with the VAT to add when it is collected) or a refusal with the plain sentence the buyer reads. Pure.
 *
 *   - a consumer placed outside the EU by agreeing evidence goes on, with no EU VAT;
 *   - evidence that is missing or contradicts refuses with the place sentence, before anything is opened;
 *   - an EU consumer of a paid product is refused while the EU record is missing or says refuse-consumers;
 *   - a free product goes on wherever the buyer is.
 * Nothing calls it yet: the routes are wired in a later unit, and sales stay closed by lib/opening.ts regardless.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EU_PLACE_REFUSED, EU_SALE_REFUSED, euCheckoutGate } from "@/lib/eu-vat-gate";
import { BILLING_COUNTRY_FIELD } from "@/lib/eu-vat-evidence";

const download = { priceCents: 2900, file: "vault/x/y/z.pdf", link: null, keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null };
const free = { ...download, priceCents: 0 };
const request = (ip: string | null, billing: string | null) => {
  const headers = new Headers(ip === null ? {} : { "x-vercel-ip-country": ip });
  const form = new URLSearchParams(billing === null ? {} : { [BILLING_COUNTRY_FIELD]: billing });
  return { headers, form };
};
const refuseConsumers = [{ jurisdiction: "EU", treatment: "refuse-consumers", implementedIn: "lib/eu-vat-gate.ts", recordedOn: "2026-11-13", registration: "", evidence: "tests/eu-vat-gate.test.ts" }];

test("10c: a consumer outside the EU goes on, with no EU VAT", () => {
  assert.deepEqual(euCheckoutGate({ product: download, ...request("US", "us") }), { ok: true, vat: null });
});

test("10c: missing or contradicting evidence refuses with the place sentence", () => {
  for (const [ip, billing] of [[null, "US"], ["US", null], ["DE", "US"], ["US", "DE"], ["XX", "XX"]] as const) {
    assert.deepEqual(euCheckoutGate({ product: download, ...request(ip, billing) }), { ok: false, reason: "place", message: EU_PLACE_REFUSED }, `${ip}/${billing}`);
  }
});

test("10c: an EU consumer of a paid product is refused while the EU record is missing or says refuse-consumers", () => {
  assert.deepEqual(euCheckoutGate({ product: download, ...request("DE", "DE") }), { ok: false, reason: "record", message: EU_SALE_REFUSED });
  assert.deepEqual(euCheckoutGate({ product: download, ...request("DE", "DE"), records: refuseConsumers }), { ok: false, reason: "treatment", message: EU_SALE_REFUSED });
});

test("10c: a free product goes on wherever the buyer is, and an unknown product never does", () => {
  assert.deepEqual(euCheckoutGate({ product: free, ...request("DE", "DE") }), { ok: true, vat: null });
  assert.deepEqual(euCheckoutGate({ product: { ...download, file: null }, ...request("DE", "DE") }), { ok: false, reason: "supply", message: EU_SALE_REFUSED });
});

test("10c: the sentences are plain US English and promise nothing", () => {
  for (const sentence of [EU_PLACE_REFUSED, EU_SALE_REFUSED]) {
    assert.ok(sentence.length > 0 && sentence.length <= 200, sentence);
    assert.ok(!/[!]|soon|sorry for the inconvenience|guarantee/i.test(sentence), sentence);
  }
});
