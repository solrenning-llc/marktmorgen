/**
 * EU VAT art. 9a, unit 11b: the billing country field beside a paid checkout (components/billing-country-field.tsx).
 * After a refused try the product page shows #country-notice; the field is then marked invalid and described by it
 * (WCAG 3.3.1, 3.3.3), and is otherwise plain. Synthetic render only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BillingCountryField } from "@/components/billing-country-field";
import { BILLING_COUNTRY_FIELD } from "@/lib/eu-vat-evidence";

const render = (problem?: string) =>
  renderToStaticMarkup(createElement(BillingCountryField, { id: "bc-p1", locale: "en-US", label: "Country you're buying from", choose: "Choose your country", problem }));

test("the field is a labeled, required native select with no country chosen for the buyer", () => {
  const html = render();
  assert.match(html, /<label for="bc-p1"[^>]*>Country you&#x27;re buying from<\/label>/);
  assert.match(html, new RegExp(`<select id="bc-p1" name="${BILLING_COUNTRY_FIELD}" required=""`));
  assert.match(html, /<option value="" disabled="" selected="">Choose your country<\/option>/);
  assert.match(html, /<option value="US">United States<\/option>/);
  assert.doesNotMatch(html, /aria-invalid|aria-describedby/);
});

test("after a refused try the field is marked invalid and described by the notice", () => {
  const html = render("country-notice");
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="country-notice"/);
});
