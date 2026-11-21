/**
 * Claude 7 numbers hunt (synthetic only): the sales, visits and sources files
 * (lib/stats.ts csvCell/csvRow) and the affiliate book (lib/affiliates.ts
 * bookCsv) kept their own copies of the cell rule, weaker than the platform's
 * one rule in lib/csv.ts:
 *
 *   - neither looked past leading spaces, so a buyer's name " =HYPERLINK(...)"
 *     (Stripe checkout, buyer-typed) reached the creator's sales file as is;
 *   - the book quoted a cell only when it held a comma, quote or line break,
 *     so a campaign name "Nice;=HYPERLINK(...)" from an affiliate's link was
 *     split at the ";" by Excel in Brazil and most of Europe, and the second
 *     half ran as a formula.
 *
 * Both now write every cell with lib/csv.ts csvCell.
 */
import { csvCell as statsCell, csvRow } from "@/lib/stats";
import { bookCsv, type Affiliate, type Book } from "@/lib/affiliates";
import { csvCell, csvLine } from "@/lib/csv";
import { done, is, part } from "./check";

function readWith(separator: string, text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let fresh = true;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && fresh) { quoted = true; fresh = false; continue; }
    if (c === separator) { row.push(cell); cell = ""; fresh = true; continue; }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = ""; fresh = true; continue;
    }
    cell += c;
    fresh = false;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
// A cell a spreadsheet would run: it starts like a formula (after spaces) and its quotes are balanced.
const formulas = (rows: string[][]) => rows.flat().filter((v) => /^\s*[=+\-@]/.test(v) && (v.match(/"/g) ?? []).length % 2 === 0);

const SAMPLES = ["plain", " =HYPERLINK(\"http://e.x\",\"x\")", "  =1+1", " =1+1", "\n=1+1", "=SUM(A1)", "+1", "-3", "@x", "\tx", "\rx", 'says "hi", twice', "Nice;=1+1", "", 42];
const PAYLOAD = "Nice;=HYPERLINK(\"http://e.x\",\"x\")";

function main(): void {
  part("Sales, visits and sources files: the platform's one cell rule");
  is("each sample cell is written exactly as lib/csv.ts writes it", SAMPLES.map((s) => statsCell(s)), SAMPLES.map((s) => csvCell(s)));
  is("a row is the platform's csvLine", csvRow([" =1+1", "Ana", 12]), csvLine([" =1+1", "Ana", 12]));
  is("(control) a plain name is quoted and unchanged", statsCell("Ana"), '"Ana"');

  part("Affiliate book: no cell reads as a formula with ; or , as separator");
  const aff = { id: "a1", email: " =1+1@example.com", code: "SARA" } as unknown as Affiliate;
  const book = {
    lines: [{ how: "sale", at: 1_762_000_000, aff: "a1", ref: "cs_1", title: " =cmd|' /C calc'!A0", base: 2_000, refunded: 0, rate: 30, commission: 600, status: "owed", currency: "usd", promotion: { source: "@x", campaign: PAYLOAD, content: "-2+3" } }],
    payouts: [{ aff: "a1", id: "p1", date: "2026-11-01", cents: 600, currency: "usd", reference: "Bank;=1+1" }],
  } as unknown as Book;
  const sheet = bookCsv(book, [aff]);
  is("with ; (Excel in Brazil) nothing runs", formulas(readWith(";", sheet)), []);
  is("with , nothing runs", formulas(readWith(",", sheet)), []);
  is("every line is the platform's csvLine", sheet.split("\r\n").filter(Boolean).every((line) => readWith(",", line)[0].length === 17 && line === csvLine(readWith(",", line)[0].map((v) => v.replace(/^'/, "")))), true);
  is("(control) the payload is kept as text, whole", readWith(",", sheet)[1][15], `${PAYLOAD}`);

  done();
}

try { main(); } catch (error) { console.error(error); process.exit(1); }
