/**
 * A spreadsheet cell that starts like a formula after leading spaces
 * (" =HYPERLINK(…)") is written as text in every export, as lib/csv.ts
 * csvCell already does: the sales, visits and sources files (lib/stats.ts)
 * and the affiliate book (lib/affiliates.ts bookCsv), whose campaign columns
 * come from links anyone can type. Synthetic values only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { csvCell as sharedCell } from "@/lib/csv";
import { csvCell as statsCell } from "@/lib/stats";
import { bookCsv, type Book } from "@/lib/affiliates";

const ATTACKS = [" =HYPERLINK(\"https://evil.example\",\"x\")", "  +1+1", " -2+3", " @SUM(1)", "\n=1+1"];
const isFormula = (cell: string) => /^"?\s*[=+\-@]/.test(cell.replace(/^"/, ""));

test("control: the shared rule writes each as text", () => {
  for (const attack of ATTACKS) assert.ok(!isFormula(sharedCell(attack)), JSON.stringify(sharedCell(attack)));
});

test("lib/stats.ts csvCell (sales, visits, sources files) writes each as text", () => {
  for (const attack of ATTACKS) assert.ok(!isFormula(statsCell(attack)), JSON.stringify(statsCell(attack)));
});

test("the affiliate book: campaign columns from a link are text", () => {
  for (const attack of ATTACKS) {
    const book = {
      lines: [{ how: "sale", at: 1_700_000_000, aff: "a1", ref: "r1", title: "Kiln guide", base: 1000, refunded: 0, rate: 30, commission: 300, status: "owed", currency: "usd", promotion: { source: attack, campaign: attack, content: attack } }],
      payouts: [],
    } as unknown as Book;
    const csv = bookCsv(book, [{ id: "a1", email: "aff@example.test", code: attack } as never]);
    const row = csv.split("\r\n")[1];
    const cells = row.match(/("([^"]|"")*"|[^,]*)/g)!.filter((c, i, all) => !(c === "" && all[i - 1] !== undefined && all[i - 1] !== ""));
    for (const cell of cells) assert.ok(!isFormula(cell.replace(/^"|"$/g, "")), `${JSON.stringify(attack)} -> ${cell}`);
  }
});

test("the affiliate book: a campaign name with a \";\" stays one quoted cell, as Excel set to \";\" reads it", () => {
  const attack = "spring;=HYPERLINK(CHAR(104)&CHAR(116)&A2)";
  const book = {
    lines: [{ how: "sale", at: 1_700_000_000, aff: "a1", ref: "r1", title: "Kiln guide", base: 1000, refunded: 0, rate: 30, commission: 300, status: "owed", currency: "usd", promotion: { source: "", campaign: attack, content: "" } }],
    payouts: [],
  } as unknown as Book;
  const row = bookCsv(book, [{ id: "a1", email: "aff@example.test", code: "c1" } as never]).split("\r\n")[1];
  // A plain RFC 4180 reader with ";" as the separator, as such a spreadsheet reads the line.
  const cells: string[] = [];
  let cell = "", quoted = false, fresh = true;
  for (let i = 0; i < row.length; i += 1) {
    const c = row[i];
    if (quoted) { if (c === '"' && row[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c; continue; }
    if (c === '"' && fresh) { quoted = true; fresh = false; continue; }
    if (c === ";") { cells.push(cell); cell = ""; fresh = true; continue; }
    cell += c; fresh = false;
  }
  cells.push(cell);
  // A cell runs when it starts like a formula and its quotes are balanced (tests/csv-one-cell-rule.test.ts).
  for (const one of cells) assert.ok(!(/^\s*[=+\-@]/.test(one) && (one.match(/"/g) ?? []).length % 2 === 0), `read with ";" a cell runs: ${one}`);
});
