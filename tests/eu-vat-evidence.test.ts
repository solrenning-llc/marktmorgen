/**
 * EU VAT under art. 9a, part 2 of the build, unit 10a: the two items of location evidence a checkout has before it
 * opens (docs/eu-vat-article-9a.md, "The code that would be needed", point 1): the country of the request's IP address
 * as Vercel's edge sets it (x-vercel-ip-country, as lib/visitor.ts reads it) and the billing country the buyer gives
 * (the form's billing_country). Each is read as it is, upper case, or nothing: never filled in from the other, never
 * defaulted. Pure, on synthetic headers and forms.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BILLING_COUNTRY_FIELD, checkoutEvidence } from "@/lib/eu-vat-evidence";
import { consumerPlace } from "@/lib/eu-vat-supply";

const form = (value?: string) => {
  const f = new URLSearchParams();
  if (value !== undefined) f.set(BILLING_COUNTRY_FIELD, value);
  return f;
};

test("both items read as given, upper case", () => {
  assert.deepEqual(checkoutEvidence(new Headers({ "x-vercel-ip-country": "de" }), form(" de ")), { ip: "DE", billing: "DE" });
});

test("a missing item stays missing, never filled from the other", () => {
  assert.deepEqual(checkoutEvidence(new Headers(), form("DE")), { ip: null, billing: "DE" });
  assert.deepEqual(checkoutEvidence(new Headers({ "x-vercel-ip-country": "DE" }), form()), { ip: "DE", billing: null });
  assert.deepEqual(consumerPlace(checkoutEvidence(new Headers(), form("DE"))), { kind: "unknown", reason: "missing" });
});

test("a value that is not two letters is kept as given, so the place reads it as not a country", () => {
  const items = checkoutEvidence(new Headers({ "x-vercel-ip-country": "DEU" }), form("Germany"));
  assert.deepEqual(items, { ip: "DEU", billing: "GERMANY" });
  assert.deepEqual(consumerPlace(items), { kind: "unknown", reason: "not-a-country" });
});

test("a billing country longer than any name is cut before it is read, never kept whole", () => {
  const items = checkoutEvidence(new Headers({ "x-vercel-ip-country": "DE" }), form("x".repeat(10_000)));
  assert.ok(typeof items.billing === "string" && items.billing.length <= 64);
});
