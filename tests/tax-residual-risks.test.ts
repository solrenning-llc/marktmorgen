/** TX6: decision evidence must distinguish risks, mitigations and unverified facts. */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const document = readFileSync("docs/tax-uncertainty.md", "utf8");
const start = "<!-- TX6-RESIDUAL-RISKS:START -->";
const end = "<!-- TX6-RESIDUAL-RISKS:END -->";
const section = document.split(start)[1]?.split(end)[0] ?? "";
const ids = ["BR-ENTITY", "BR-PERSON", "INSS", "ISS", "US-CLOUD", "FACILITATOR"];
const rows = section.split("\n").filter((line) => /^\| (BR-ENTITY|BR-PERSON|INSS|ISS|US-CLOUD|FACILITATOR) \|/.test(line));

test("all six residual risks have separate aggravating facts, design measures, missing evidence and sources", () => {
  assert.equal(document.split(start).length, 2, "one current register, separate from the historical research");
  assert.equal(document.split(end).length, 2);
  assert.deepEqual(rows.map((row) => row.split("|")[1].trim()), ids);
  for (const row of rows) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 5);
    assert.ok(cells.slice(1, 4).every((cell) => cell.length > 50), `${cells[0]} needs facts, a measure and a remaining gap`);
    const refs = [...cells[4].matchAll(/\[R\d+\]/g)].map((match) => match[0]);
    assert.ok(refs.length > 0, `${cells[0]} needs primary evidence`);
    for (const ref of refs) assert.ok(section.includes(`${ref}: https://`), `${ref} must resolve inside the current register`);
  }
});

test("primary sources carry a read date and source status; proposed cloud sourcing is not a final rule", () => {
  assert.match(section, /Read on: 2026-11-04/);
  for (const id of ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"]) {
    assert.match(section, new RegExp(`\\[${id}\\]: https://(?:www2\\.camara\\.leg\\.br|www\\.planalto\\.gov\\.br|www\\.ecfr\\.gov|www\\.irs\\.gov|app\\.leg\\.wa\\.gov|laws-lois\\.justice\\.gc\\.ca)/`));
    assert.match(section, new RegExp(`\\*\\*${id} — [^\\n]+`));
  }
  assert.match(section, /REG-107420-24[^\n]*proposed/i);
  assert.match(section, /not a final sourcing rule/i);
});

test("the decision boundary preserves unknown costs and does not turn European hosting into an opening gate", () => {
  assert.match(section, /Unknown costs remain UNKNOWN, never zero/);
  assert.match(section, /European hosting is risk reduction, not an opening gate/);
  assert.match(section, /No tax consultation is required or prepared/);
  assert.match(section, /No conclusion of tax exemption, compliance, profit or opening readiness/);
  assert.match(section, /Historical material below remains unchanged/);
});
