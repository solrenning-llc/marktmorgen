import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const document = readFileSync("docs/llc-fixed-costs-2026-10-22.md", "utf8");
const heading = "## TX4 — official CBE reporting evidence (4 November 2026)";

function evidenceSection(): string {
  const start = document.indexOf(heading);
  assert.notEqual(start, -1, "the dated CBE evidence section is missing");
  const end = document.indexOf("\n## TX4 — official U.S. federal filing evidence", start);
  assert.ok(end > start, "the CBE section must end before the separate U.S. evidence");
  return document.slice(start, end);
}

test("CBE evidence distinguishes the resident's aggregate assets from an LLC's revenue", () => {
  const section = evidenceSection();
  for (const fact of [
    "Resolução BCB 279/2022",
    "numero=279",
    "arts. 7–12",
    "resident individual or legal entity",
    "aggregate foreign assets",
    "at least USD 1,000,000",
    "31 December",
    "at least USD 100,000,000",
    "31 March, 30 June and 30 September",
    "not the LLC's revenue or the Marktmorgen customer count",
    "Brazilian BDRs and domestic investment-fund units",
    "full jointly owned asset for threshold testing",
    "only the declarant's share is reported",
    "positive assets",
    "negative-equity companies",
    "no separate fourth-quarter return",
    "does not establish the owner's residence, aggregate assets or reporting obligation",
  ]) assert.ok(section.includes(fact), fact);
});

test("CBE evidence separates recurring periods from a dated calendar and preserves receipt and retention requirements", () => {
  const section = evidenceSection();
  for (const fact of [
    "https://www.bcb.gov.br/meubc/faqs/p/prazos-para-entrega-da-declaracao",
    "15 February–5 April of the following year",
    "30 April–5 June",
    "31 July–5 September",
    "31 October–5 December",
    "next business day",
    "https://www.bcb.gov.br/estabilidadefinanceira/cbeanual",
    "2026 annual declaration concerns 31 December 2025",
    "6 April 2026",
    "not a deadline for 31 December 2026",
    "10 years from the declaration's reference date",
    "delivery protocol",
    "saved draft is not a delivered declaration",
  ]) assert.ok(section.includes(fact), fact);
});

test("CBE evidence records penalty categories and does not price missing compliance work at zero", () => {
  const section = evidenceSection();
  for (const fact of [
    "Manual do Declarante 2026",
    "Manual_CBE_a_partir_de_2017.pdf",
    "late submission",
    "incorrect or incomplete information",
    "non-submission or missing supporting documents",
    "false information",
    "https://www.gov.br/pt-br/servicos/preencher-declaracao-de-capitais-brasileiros-no-exterior",
    "public submission service is free",
    "does not make preparation, review, valuation, translation, recordkeeping or corrections free",
    "br-cbe",
    "complete monetary ceiling remains unknown and unreserved",
    "unknown is rejection, never zero",
    "IRPF reporting remains a separate unresolved TX4 component",
  ]) assert.ok(section.includes(fact), fact);
  assert.doesNotMatch(section, /(?:CBE|compliance)\s+(?:cost|ceiling)\s*(?:is|=|:)\s*(?:USD\s*)?0\b/i);
});
