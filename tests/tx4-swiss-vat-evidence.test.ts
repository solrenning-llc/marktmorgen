import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { allocateEntireLlcFixedCosts, CURRENT_LLC_FIXED_COST_CEILINGS } from "../lib/llc-fixed-costs";

const path = "docs/tx4-swiss-vat-evidence.md";
const document = existsSync(path) ? readFileSync(path, "utf8") : "";

test("TX4 dates the Swiss primary evidence and keeps actual applicability conditional", () => {
  for (const fact of [
    "Read on 4 November 2026 (America/Fortaleza)",
    "https://www.estv.admin.ch/fr/tva-assujettissement-entreprises-etrangeres",
    "https://www.estv.admin.ch/fr/tva-decompte-annuel-2025",
    "https://www.estv.admin.ch/en/paying-vat",
    "https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/2009/615/20250331/fr/html/fedlex-data-admin-ch-eli-cc-2009-615-20250331-fr-html.html",
    "31 March 2025", "not a conclusion about this LLC", "TX4 remains incomplete",
  ]) assert.ok(document.includes(fact), fact);
});

test("TX4 distinguishes representation waiver and annual filing from recurring cash obligations", () => {
  for (const fact of [
    "Article 67(1bis)", "waiver is not presumed",
    "quarterly", "half-yearly", "CHF 5,005,000", "upon request",
    "Articles 71(1) and 86(1)", "within 60 days", "Article 86a",
    "annual filing does not mean annual-only cash funding",
    "Article 72", "180th day", "online reporting",
    "Article 70", "Article 42(6)", "ten years", "20 years",
    "not a universal deletion date",
  ]) assert.ok(document.includes(fact), fact);
});

test("TX4 evidence never prices unknown Swiss compliance or approves the LLC allocation", () => {
  for (const fact of [
    "complete monetary ceiling remains unknown and unreserved",
    "representative", "preparation and review", "recordkeeping",
    "currency conversion", "reserve timing", "100% Marktmorgen",
    "No account, registration, filing, payment or external contact",
    "does not establish zero compliance cost",
  ]) assert.ok(document.includes(fact), fact);
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(line => line.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.equal(line.fullMonthlyUsdCents, null);
  assert.equal(line.fullAnnualUsdCents, null);
  assert.equal(line.reserveReviewed, false);
  assert.equal(allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS), null);
});
