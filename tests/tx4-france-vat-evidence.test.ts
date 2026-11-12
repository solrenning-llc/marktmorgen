import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION } from "../lib/llc-fixed-costs";

const read = () => readFileSync("docs/tx4-france-vat-evidence.md", "utf8");

test("TX4 French VAT evidence dates primary sources without selecting the LLC's local obligation", () => {
  const text = read();
  for (const source of [
    "https://www.impots.gouv.fr/immatriculation-la-tva",
    "https://www.impots.gouv.fr/international-professionnel/taxe-sur-la-valeur-ajoutee",
    "https://bofip.impots.gouv.fr/bofip/13166-PGP.html/identifiant=BOI-TVA-DECLA-30-10-15-20211222",
    "https://entreprendre.service-public.gouv.fr/vosdroits/F23208",
    "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000041471233/",
    "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006219327/",
  ]) assert.ok(text.includes(source), source);
  for (const fact of ["05/11/2026", "3 March 2025", "14 September 2023", "22 December 2021", "7 August 2026", "1 January 2023", "4 January 2003", "reverse charge", "fiscal representative"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /does not determine the LLC's registration/);
  assert.match(text, /not proof that OSS discharges every local obligation/);
});

test("TX4 French VAT filing guidance preserves scoped frequency and nil-return differences", () => {
  const text = read();
  for (const fact of ["SIEE", "EM", "ET", "ES", "monthly", "quarterly", "seasonal", "19th", "nil return", "not a verified 2026 account calendar", "older distance-sales threshold"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /seasonal.*no return.*no taxable transaction/);
  assert.match(text, /does not select.*regime.*office/);
  assert.doesNotMatch(text, /(?:LLC|Marktmorgen)\s+(?:must|will)\s+(?:file|register|appoint)/i);
});

test("TX4 French record evidence distinguishes fiscal, OSS and commercial periods without changing deletion", () => {
  const text = read();
  for (const fact of ["L102 B", "six years", "last operation", "document creation", "ten years", "31 December", "L123-22", "euros", "French", "electronic", "not a deletion schedule", "after closure"]) assert.ok(text.includes(fact), fact);
  assert.match(text, /does not impose.*French.*LLC/);
  assert.match(text, /does not change retention, storage location or deletion code/);
});

test("TX4 French compliance work does not turn unknown cost into zero or a funded reserve", () => {
  const text = read();
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.deepEqual([line.fullMonthlyUsdCents, line.fullAnnualUsdCents, line.reserveReviewed], [null, null, false]);
  assert.deepEqual([LLC_FIXED_COST_ALLOCATION.marktmorgenBps, LLC_FIXED_COST_ALLOCATION.hazelsongBps], [10000, 0]);
  for (const fact of ["vat-oss-and-local-compliance", "unknown, never zero", "100% Marktmorgen", "currency", "storage", "reserve", "Owner-dependent", "No registration, submission, payment, account or external contact"]) assert.ok(text.includes(fact), fact);
  assert.doesNotMatch(text, /(?:USD|EUR|US\$|€)\s*0(?:[.,]0+)?\b/i);
});
