import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION } from "../lib/llc-fixed-costs";

const read = () => readFileSync("docs/tx4-portugal-vat-evidence.md", "utf8");

test("Portuguese evidence keeps the non-Union OSS route conditional on the LLC facts and a Portuguese choice", () => {
  const text = read();
  for (const source of [
    "https://diariodarepublica.pt/dr/detalhe/lei/47-2020-140950562",
    "https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/civa_rep/Pages/C-IVA-RegEspecial_Lei47_2020.aspx",
    "https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/legislacao/instrucoes_administrativas/Documents/Oficio_circulado_%2030240_2021.pdf",
  ]) assert.ok(text.includes(source), source);
  assert.match(text, /2026-11-05/);
  assert.match(text, /optional[\s\S]*Portugal[\s\S]*Member State of identification/i);
  assert.match(text, /all services[\s\S]*non-taxable persons/i);
  assert.match(text, /does not determine[\s\S]*LLC[\s\S]*establishment[\s\S]*customer status/i);
  assert.match(text, /does not select[\s\S]*place of supply[\s\S]*registration/i);
});

test("Portuguese OSS filing evidence preserves quarterly, zero-return and deadline qualifications", () => {
  const text = read();
  const source = "https://info.portaldasfinancas.gov.pt/pt/apoio_contribuinte/Comercio_eletronico/Orientacoes/Documents/OSS_guidelines_pt_1.pdf";
  assert.ok(text.includes(source), source);
  for (const fact of [
    "calendar quarter",
    "end of the following month",
    "zero return",
    "weekend or national holiday",
    "does not extend",
    "all covered services",
    "not a calendar assigned to the LLC",
  ]) assert.ok(text.includes(fact), fact);
});

test("Portuguese payment, currency and operation-record evidence remains conditional", () => {
  const text = read();
  for (const fact of [
    "declaration reference",
    "bank transfer",
    "euro",
    "European Central Bank",
    "last day of the period",
    "ten years",
    "end of the year",
    "electronically",
    "on request",
  ]) assert.ok(text.includes(fact), fact);
  assert.match(text, /not a universal ten-year deletion rule/i);
  assert.match(text, /does not change retention, storage location or deletion code/i);
  assert.match(text, /does not calculate tax[\s\S]*authorize filing or payment/i);
});

test("Portuguese compliance work leaves the complete company cost unknown and unfunded", () => {
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
    "records",
    "reserve",
    "Owner-dependent",
    "No registration, submission, payment, account or external contact",
  ]) assert.ok(text.includes(fact), fact);
  assert.doesNotMatch(text, /(?:USD|EUR|US\$|€)\s*0(?:[.,]0+)?\b/i);
});
