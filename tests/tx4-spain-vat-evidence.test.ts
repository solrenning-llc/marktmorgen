import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION } from "../lib/llc-fixed-costs";

const read = () => readFileSync("docs/tx4-spain-vat-evidence.md", "utf8");

test("Spanish evidence keeps the non-Union OSS route conditional on the LLC facts and a Spanish choice", () => {
  const text = read();
  for (const source of [
    "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740",
    "https://sede.agenciatributaria.gob.es/Sede/iva/iva-comercio-electronico/regimenes-especiales-ventanilla-unica.html",
    "https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/manual-iva-2025/capitulo-06-regimenes-especiales-iva/reg-espec-ventas-distancia-entreg-servic/regimen-exterior-union.html",
  ]) assert.ok(text.includes(source), source);
  assert.match(text, /2026-11-05/);
  assert.match(text, /optional[\s\S]*Spain[\s\S]*Member State of identification/i);
  assert.match(text, /does not determine[\s\S]*LLC[\s\S]*establishment[\s\S]*customer status/i);
  assert.match(text, /does not select[\s\S]*place of supply[\s\S]*registration/i);
});

test("Spanish Model 369 evidence preserves quarterly, zero-return and deadline qualifications", () => {
  const text = read();
  for (const source of [
    "https://sede.agenciatributaria.gob.es/Sede/iva/iva-comercio-electronico/presentacion-autoliquidaciones-periodicas-modelo-369.html",
    "https://sede.agenciatributaria.gob.es/Sede/eu_es/ayuda/calendario-contribuyente/calendario-contribuyente-2026/recuerde/vencimientos-dias-inhabiles-sabados-festivos.html",
  ]) assert.ok(text.includes(source), source);
  for (const fact of [
    "Model 369",
    "calendar quarter",
    "following calendar month",
    "zero return",
    "weekend or public holiday",
    "does not extend",
    "all covered supplies",
    "deduct input VAT",
  ]) assert.ok(text.includes(fact), fact);
  assert.match(text, /not a calendar assigned to the LLC/i);
});

test("Spanish invoice and operation-record evidence preserves the ten-year special-scheme boundary", () => {
  const text = read();
  for (const source of [
    "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28925",
    "https://sede.agenciatributaria.gob.es/Sede/iva/iva-comercio-electronico/nuevos-regimenes-especiales-ventanilla-unica/formulario-normalizado-presentacion-registros-operaciones.html",
  ]) assert.ok(text.includes(source), source);
  assert.match(text, /issue and deliver invoices[\s\S]*Spain[\s\S]*Member State of identification/i);
  assert.match(text, /ten years[\s\S]*end of the year[\s\S]*transaction/i);
  assert.match(text, /electronically[\s\S]*requested/i);
  assert.match(text, /not a universal ten-year deletion rule/i);
  assert.match(text, /does not change retention, storage location or deletion code/i);
});

test("Spanish compliance work leaves the complete company cost unknown and unfunded", () => {
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
    "invoice",
    "records",
    "reserve",
    "Owner-dependent",
    "No registration, submission, payment, account or external contact",
  ]) assert.ok(text.includes(fact), fact);
  assert.doesNotMatch(text, /(?:USD|EUR|US\$|€)\s*0(?:[.,]0+)?\b/i);
});
