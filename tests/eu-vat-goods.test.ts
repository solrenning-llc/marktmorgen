/**
 * EU VAT, part 2 of the build, unit 9a: goods shipped to an EU address (docs/eu-vat-article-9a.md, "The code that
 * would be needed", point 8; question 27). Directive 2006/112/EC art. 14a deems an interface that facilitates a supply
 * of goods within the EU by a seller not established there, or an import of up to EUR 150, to have supplied them; that
 * treatment is not built. So until it is, the countries a checkout lets a physical product ship to leave out every
 * Member State (and the territories whose VAT treatment the code cannot settle) when the creator's own Stripe account
 * is not in the EU, or when its country is not known. Pure.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { shipCountriesUnderEuVat } from "@/lib/eu-vat-goods";

test("a creator whose account is outside the EU ships to no Member State", () => {
  assert.deepEqual(shipCountriesUnderEuVat(["US", "DE", "CA", "FR", "IE"], "US"), ["US", "CA"]);
});

test("a creator whose account's country is unknown ships to no Member State either", () => {
  for (const country of [null, "", "XX", "us1", 7 as never]) assert.deepEqual(shipCountriesUnderEuVat(["US", "DE"], country), ["US"], String(country));
});

test("territories the code cannot settle are left out too", () => {
  assert.deepEqual(shipCountriesUnderEuVat(["US", "MC", "IC", "EA"], "US"), ["US"]);
});

test("a creator whose account is in the EU keeps the list as it is (art. 14a does not deem a supply by an EU seller within the EU)", () => {
  assert.deepEqual(shipCountriesUnderEuVat(["US", "DE", "FR"], "DE"), ["US", "DE", "FR"]);
});

test("a list that is not a list of country codes is refused whole", () => {
  assert.equal(shipCountriesUnderEuVat("US" as never, "US"), null);
  assert.equal(shipCountriesUnderEuVat(["US", 7 as never], "US"), null);
});
