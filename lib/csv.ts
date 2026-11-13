/**
 * Reading the spreadsheets creators bring from other platforms, and writing
 * the ones we hand back.
 *
 * A file exported by Stan, Gumroad, Kajabi, Mailchimp, Excel or Google Sheets
 * can arrive in any of a handful of shapes, and every one of them has to read
 * the same:
 *
 *   - a byte-order mark at the start (Excel's "CSV UTF-8" writes one), which
 *     is dropped rather than read as part of the first column's name;
 *   - commas, semicolons (Excel in much of Europe) or tabs between cells —
 *     whichever the first line uses outside quotes, unless the file starts
 *     with Excel's "sep=;" line naming it, which is then dropped (it is not
 *     the header, and not a row toward any limit);
 *   - cells in double quotes, holding the separator, line breaks, or a quote
 *     written twice ("") for one;
 *   - lines ending in \r\n, \n or \r, and blank lines, which are skipped.
 *
 * It reads text, not bytes: the browser decodes the file as UTF-8 before this
 * sees it, so accented names and every alphabet come through as typed.
 *
 * A cell we write back into a spreadsheet — an error report, an export — is
 * always quoted, and one that begins with =, +, -, @ or a tab (after any
 * spaces) gets a ' in front, so a spreadsheet shows it as text instead of
 * running it as a formula. A name like "=HYPERLINK(...)" in a creator's own
 * file never becomes a link in the report we give them.
 *
 * Pure, so the studio's own screen and the server read a file the same way.
 */

export type Separator = "," | ";" | "\t";

export type ParsedCsv = {
  /** The first row, as the file names its columns. */
  header: string[];
  /** Every other row that has anything in it, in order. */
  rows: string[][];
  /** What the cells were separated by. */
  separator: Separator;
  /** The row number each row had in the file, counting the header as 1, for reports. */
  lines: number[];
  /** Whether rows past `maxRows` were left unread. */
  truncated: boolean;
};

/** How many of each separator each of a file's first `most` lines has, outside quotes. */
function separatorCounts(text: string, most: number): Record<Separator, number>[] {
  const lines: Record<Separator, number>[] = [];
  let counts: Record<Separator, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length && lines.length < most; i += 1) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      if (counts[","] + counts[";"] + counts["\t"] > 0 || lines.length === 0) lines.push(counts);
      counts = { ",": 0, ";": 0, "\t": 0 };
    } else if (!quoted && (c === "," || c === ";" || c === "\t")) counts[c] += 1;
  }
  if (lines.length < most && (counts[","] + counts[";"] + counts["\t"] > 0 || lines.length === 0)) lines.push(counts);
  return lines;
}

/**
 * The separator a file uses: the one its first line has most of, outside
 * quotes. A tie between ";" and "," (a header such as "Email;Name, as typed")
 * is settled by the lines below: the one that gives as many cells on them as
 * on the first line, and a comma when they cannot tell.
 */
export function detectSeparator(text: string): Separator {
  const [first, ...below] = separatorCounts(text, 6);
  const counts = first ?? { ",": 0, ";": 0, "\t": 0 };
  if (counts[";"] > 0 && counts[";"] === counts[","] && counts[";"] >= counts["\t"] && below.length) {
    const steady = (sep: Separator) => below.filter((line) => line[sep] === counts[sep]).length;
    if (steady(";") > steady(",")) return ";";
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  return ",";
}

/**
 * Reads a CSV file's text. `maxRows` stops reading after that many rows
 * below the header, so a file far past a limit is not held whole; a file
 * that is longer says so with `truncated`.
 */
export function parseCsv(input: string, maxRows = Number.POSITIVE_INFINITY): ParsedCsv {
  const unmarked = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  // Excel's "sep=;" first line names the separator; dropped, the file's own line numbers kept.
  const hint = /^sep=([,;\t])(?:\r\n|\r|\n|$)/.exec(unmarked);
  const text = hint ? unmarked.slice(hint[0].length) : unmarked;
  const separator = hint ? (hint[1] as Separator) : detectSeparator(text);
  const all: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = hint ? 2 : 1;
  let rowLine = line;
  let truncated = false;
  const endRow = () => {
    row.push(cell);
    cell = "";
    // A line with nothing in any cell is not a row.
    if (row.some((value) => value.trim() !== "")) {
      all.push(row);
      lines.push(rowLine);
    }
    row = [];
  };
  let i = 0;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line += 1;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell.trim() === "") {
      // A quote opens a cell only at its start; spaces before it are dropped.
      cell = "";
      quoted = true;
    } else if (c === separator) {
      row.push(cell);
      cell = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
      line += 1;
      rowLine = line;
      // One row past the limit is read, to know that there are more.
      if (all.length > maxRows + 1) break;
    } else {
      cell += c;
    }
  }
  if (!truncated && (cell !== "" || row.length > 0)) endRow();
  if (all.length > maxRows + 1) {
    all.length = maxRows + 1;
    lines.length = maxRows + 1;
    truncated = true;
  }
  const [header = [], ...rows] = all;
  const [, ...rowLines] = lines;
  return { header: header.map((h) => h.trim()), rows, separator, lines: rowLines, truncated };
}

/** One cell as a spreadsheet will read it back: quoted, and never a formula. */
export function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[\s]*[=+\-@]/.test(text) || /^[\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function csvLine(values: (string | number)[]): string {
  return values.map(csvCell).join(",");
}

/**
 * The column a file most likely means for one field, from its header: the
 * first whose name matches one of `names` exactly (ignoring case, spaces,
 * dashes and underscores), then the first that contains one. -1 for none.
 */
export function guessColumn(header: string[], names: string[]): number {
  const squash = (s: string) => s.toLowerCase().replace(/[\s_\-.]+/g, "");
  const heads = header.map(squash);
  const wanted = names.map(squash);
  for (const name of wanted) {
    const at = heads.indexOf(name);
    if (at >= 0) return at;
  }
  for (const name of wanted) {
    const at = heads.findIndex((h) => h.includes(name));
    if (at >= 0) return at;
  }
  return -1;
}

/**
 * What a consent column says, in the words the platforms write it in:
 * yes, no, or not understood. An empty cell is a no: nobody is written to
 * because a cell was left blank.
 */
export function readConsent(raw: string): "yes" | "no" | "unknown" {
  const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (value === "") return "no";
  const yes = ["yes", "y", "true", "1", "x", "✓", "✔", "opted in", "opt in", "optin", "subscribed", "agreed", "consented", "confirmed", "accepted", "granted", "marketing", "on"];
  const no = ["no", "n", "false", "0", "opted out", "opt out", "optout", "unsubscribed", "not subscribed", "declined", "refused", "denied", "off", "none", "pending", "cleaned", "bounced", "non subscribed", "nonsubscribed"];
  if (yes.includes(value)) return "yes";
  if (no.includes(value)) return "no";
  return "unknown";
}
