import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = () => readFileSync("docs/tx4-italy-vat-evidence.md", "utf8");

test("the dated evidence uses the current consolidated VAT Directive", () => {
  const text = read();
  assert.match(
    text,
    /https:\/\/eur-lex\.europa\.eu\/legal-content\/en\/TXT\/\?uri=CELEX%3A02006L0112-20250414/,
    "the 2026 evidence snapshot must cite EUR-Lex's current 14 April 2025 consolidation, not the superseded 1 January 2024 consolidation",
  );
  assert.doesNotMatch(text, /02006L0112-20240101/);
});

test("the note keeps the Italian source scope conditional", () => {
  const text = read();
  assert.match(text, /Those descriptions are conditions, not findings about Marktmorgen/);
  assert.match(text, /Ordinary Italian VAT registration and the non-Union OSS route are not interchangeable defaults/);
  assert.match(text, /not a calendar assigned to the LLC/);
});

test("the note preserves the OSS record boundary", () => {
  const text = read();
  assert.match(text, /ten years from the end of the year in which the transaction occurred/);
  assert.match(text, /not a universal ten-year deletion rule/);
  assert.match(text, /does not change retention, storage location or deletion code/);
});

test("the note does not turn unknown compliance work into a funded action", () => {
  const text = read();
  assert.match(text, /complete cost remains unknown, never zero/);
  assert.match(text, /reserveReviewed.*false/);
  assert.match(text, /No registration, submission, payment, account or external contact has been made or authorized/);
});
