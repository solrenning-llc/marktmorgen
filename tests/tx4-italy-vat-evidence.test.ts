import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION } from "../lib/llc-fixed-costs";

const read = () => readFileSync("docs/tx4-italy-vat-evidence.md", "utf8");

test("Italian evidence keeps the optional non-Union OSS route conditional on the LLC facts", () => {
  const text = read();
  for (const source of [
    "https://www1.agenziaentrate.gov.it/servizi/scadenzario/main.php/main.php?chi=3814&come=516&cosa=3098&entroil=30-04-2025&op=4",
    "https://telematici.agenziaentrate.gov.it/Main/Avviso?id=20210401214329",
    "https://www.normattiva.it/atto/caricaDettaglioAtto?atto.codiceRedazionale=21G00094&atto.dataPubblicazioneGazzetta=2021-06-15&tipoDettaglio=originario",
    "https://eur-lex.europa.eu/eli/dir/2006/112/2025-04-14/eng",
  ]) assert.ok(text.includes(source), source);
  assert.match(text, /2026-11-05/);
  assert.match(text, /current consolidated version[\s\S]*14 April 2025/i);
  assert.match(text, /non-Union scheme[\s\S]*services[\s\S]*non-taxable persons/i);
  assert.match(text, /optional[\s\S]*Member State of identification/i);
  assert.match(text, /does not determine[\s\S]*LLC[\s\S]*registration/i);
  assert.match(text, /does not select[\s\S]*place of supply[\s\S]*classification/i);
});

test("Italian filing evidence preserves the exact quarterly, nil-return and payment qualifications", () => {
  const text = read();
  for (const source of [
    "https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/declare-and-pay-oss_en",
    "https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/record-keeping-and-audits-oss_en",
  ]) assert.ok(text.includes(source), source);
  for (const fact of [
    "30 April 2025",
    "previous quarter",
    "nil return",
    "end of the following month",
    "Portale OSS",
    "F24 without offset",
    "bank transfer",
    "unique return reference",
    "euro",
    "European Central Bank",
  ]) assert.ok(text.includes(fact), fact);
  assert.match(text, /payment[\s\S]*same deadline[\s\S]*return/i);
  assert.match(text, /not a calendar assigned to the LLC/i);
});

test("Italian invoice and record evidence remains conditional and does not create a deletion rule", () => {
  const text = read();
  assert.match(text, /Title II[\s\S]*does not apply[\s\S]*if an invoice is issued[\s\S]*Articles 21 and following/i);
  assert.match(text, /ten years[\s\S]*end of the year[\s\S]*transaction/i);
  assert.match(text, /electronically[\s\S]*without delay/i);
  assert.match(text, /not a universal ten-year deletion rule/i);
  assert.match(text, /does not change retention, storage location or deletion code/i);
});

test("Italian compliance work leaves the complete company cost unknown and unfunded", () => {
  const text = read();
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.deepEqual([line.fullMonthlyUsdCents, line.fullAnnualUsdCents, line.reserveReviewed], [null, null, false]);
  assert.deepEqual([LLC_FIXED_COST_ALLOCATION.marktmorgenBps, LLC_FIXED_COST_ALLOCATION.hazelsongBps], [10000, 0]);
  for (const fact of [
    "vat-oss-and-local-compliance",
    "complete cost remains unknown, never zero",
    "100% Marktmorgen",
    "registration",
    "calendar",
    "currency",
    "retention",
    "storage",
    "reserve",
    "Owner-dependent",
    "No registration, submission, payment, account or external contact",
  ]) assert.ok(text.includes(fact), fact);
  assert.doesNotMatch(text, /(?:USD|EUR|US\$|€)\s*0(?:[.,]0+)?\b/i);
});
