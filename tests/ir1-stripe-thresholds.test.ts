/**
 * 753 [IR1], unit 3a: where the creator may need to register. Stripe Tax already compares the sales on the creator's
 * own account with each place's registration limit (https://docs.stripe.com/tax/monitoring, read 15 November 2026), and
 * its results are not in Stripe's public API (only a private preview), so the studio does not recount them: it says
 * what Stripe counts and opens the "Needs attention" tab of the creator's own Stripe Tax page. Synthetic only.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NOT_TAX_ADVICE, needsAttentionPage } from "@/lib/registration-thresholds";

test("the link opens the Needs attention tab of the same Locations page, in test or live mode", () => {
  assert.equal(needsAttentionPage("https://dashboard.stripe.com/tax/locations"), "https://dashboard.stripe.com/tax/locations?primary_tab=needs_attention");
  assert.equal(needsAttentionPage("https://dashboard.stripe.com/test/tax/locations"), "https://dashboard.stripe.com/test/tax/locations?primary_tab=needs_attention");
  for (const other of ["https://example.com/tax/locations", "https://dashboard.stripe.com/settings/tax", "", "javascript:alert(1)"]) {
    assert.equal(needsAttentionPage(other), null, other);
  }
});

test("the fixed sentence the item asks for", () => {
  assert.equal(NOT_TAX_ADVICE, "This is information from your sales, not tax advice.");
});

test("the tax page has the section, honest about what Stripe counts, only with a Stripe account", () => {
  const page = readFileSync("app/studio/tax/page.tsx", "utf8");
  const section = page.slice(page.indexOf('aria-labelledby="thresholds-title"'));
  assert.ok(page.includes('aria-labelledby="thresholds-title"'), "a named section");
  assert.match(section, /<h2 id="thresholds-title"[^>]*>Where you may need to register<\/h2>/);
  assert.match(section, /needsAttentionPage\(registrations\.dashboard\)/);
  assert.match(section, /<NewTab \/>/, "says it opens a new tab");
  for (const fact of ["only the sales Stripe processed", "refunds", "live mode", "your home country", "10,000 USD"]) {
    assert.ok(section.includes(fact), fact);
  }
  assert.match(section, /\{NOT_TAX_ADVICE\}/);
  assert.match(section, /sellsThroughPayPal\(store\)/, "PayPal sales are not in Stripe's count, and it says so");
  assert.ok(page.indexOf('aria-labelledby="thresholds-title"') > page.indexOf('aria-labelledby="registrations-title"'));
});
