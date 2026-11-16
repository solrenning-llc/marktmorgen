/**
 * The buyers' file for ad audiences (lib/ad-audience.ts, audienceCsv) follows
 * the platform's one rule for a cell written into a spreadsheet (lib/csv.ts,
 * csvCell): every address is quoted, and one that begins with =, +, - or @
 * (after any spaces), a tab or a CR gets a ' in front, so a spreadsheet shows
 * it as text. The header stays the fixed word "email" that Meta's customer
 * list and TikTok's customer file name their column with, and the file stays
 * one address a line. Synthetic addresses only.
 */
import { audienceCsv } from "@/lib/ad-audience";
import { csvCell } from "@/lib/csv";
import { done, is, part } from "./check";

/** A plain RFC 4180 reader with a chosen separator, the way a spreadsheet reads the file. */
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

/** A cell a spreadsheet would read as a formula. */
const live = (cell: string) => /^[\s]*[=+\-@]/.test(cell) || /^[\t\r]/.test(cell);

part("Every address follows the one cell rule");
const leading = ["=sum(1+1)@example.com", "+one@example.com", "-two@example.com", " =three@example.com"];
const file = audienceCsv([...leading, "plain@example.com"]);
const lines = file.split("\r\n");
is("the header is still the bare word the platforms read", lines[0], "email");
is("each address line is that address as one quoted cell", lines.slice(1, -1), [...leading.map((e) => e.trim()), "plain@example.com"].sort().map(csvCell));
for (const separator of [",", ";"]) {
  const cells = readWith(separator, file).slice(1).flat();
  is(`read with "${separator}", no address cell runs as a formula`, cells.filter(live), []);
  is(`read with "${separator}", one cell a line`, readWith(separator, file).map((row) => row.length), [1, 1, 1, 1, 1, 1]);
}
const separated = audienceCsv(["a;=one@example.com", "b,=two@example.com"]);
is("an address holding a separator stays in its one cell", [readWith(";", separated).slice(1), readWith(",", separated).slice(1)], [
  [["a;=one@example.com"], ["b,=two@example.com"]],
  [["a;=one@example.com"], ["b,=two@example.com"]],
]);

part("A real address reads back as itself");
const real = audienceCsv(["B@Example.com", "a@example.com", "a@example.com ", "not-an-address"]);
is("lowercased, trimmed, without repeats or lines with no @, sorted", readWith(",", real), [["email"], ["a@example.com"], ["b@example.com"]]);
is("the bytes", real, 'email\r\n"a@example.com"\r\n"b@example.com"\r\n');
is("an empty file still has its header", audienceCsv([]), "email\r\n");

done();
