/**
 * The twelve months of earnings as a CSV file (426 [BX2] unit 4;
 * docs/bx2-earnings-design.md, "Units", 5).
 *
 * The file is the months the earnings page last read and kept
 * (app/studio/earnings/page.tsx, lib/earnings-read.ts), written out row by
 * row: one row for each month, source and currency, the same rows the page
 * shows. It is made from the kept copy only (app/api/store/earnings/route.ts):
 * it never reads Stripe or PayPal and never takes one of the day's readings.
 *
 *   - Unknown is said, never zero: a source that could not be read for a
 *     month is one row "Could not be read" with no currency and no amount;
 *     a month read in full with nothing in it is "Nothing recorded", also
 *     with no amount; a month whose sources were not all read has "No total".
 *   - Currencies are never added together and nothing is converted: each
 *     currency has its own rows. Amounts are exact, written from the smallest
 *     unit with the currency's own decimals (lib/money.ts, decimalsOf), never
 *     through a floating-point division.
 *   - Amounts are before Stripe's and PayPal's fees and taxes: the last
 *     column is "left after refunds and disputes", not profit.
 *   - Every text cell is quoted and guarded against formulas (lib/csv.ts,
 *     csvCell); an amount is a plain number checked to be only digits, one
 *     point and maybe a minus sign, so no cell can run in a spreadsheet.
 *   - No personal data: amounts by month, source and currency only. No
 *     buyer, address, product or Stripe or PayPal record id is in the copy,
 *     so none can reach the file.
 *   - Nothing ranks or rates the creator by revenue (561 [NE1]).
 *
 * The copy kept in Redis is read back only in the exact shape the rule
 * (lib/earnings-by-month.ts) makes: every sum added again and compared, the
 * months the reading's time gives, the totals the sources give. Anything
 * else is no file, never a guess.
 *
 * Pure: the route and the tests read one rule.
 */
import { csvCell } from "@/lib/csv";
import { decimalsOf } from "@/lib/money";
import {
  EARNINGS_MONTHS,
  type Earnings,
  type EarningsMonth,
  type EarningsSource,
  type MonthLine,
  type MoneyKind,
  type SourceMonth,
  type UnknownWhy,
  SOURCE_WORDS,
  earningsMonths,
  monthFloor,
} from "@/lib/earnings-by-month";

export const EARNINGS_CSV_HEADER = [
  "month",
  "so_far",
  "source",
  "state",
  "currency",
  "sales",
  "renewals",
  "refunds",
  "disputes",
  "left_after_refunds_and_disputes",
  "not_included",
  "time_zone",
  "read_at_utc",
] as const;

/** The words of a row's state: what the page says for the same month and source. */
export const EARNINGS_CSV_STATES = {
  read: "Read",
  unknown: "Could not be read",
  nothing: "Nothing recorded",
  noTotal: "No total: a source could not be read",
} as const;

const KIND_WORDS: Record<MoneyKind, string> = { sale: "sales", renewal: "renewals", refund: "refunds", dispute: "disputes" };
const ALL_SOURCES = "All sources";

// ---------------------------------------------------------------------------
// Reading the kept copy back, in the rule's exact shape
// ---------------------------------------------------------------------------

type Plain = Record<string, unknown>;
const SOURCES: ReadonlySet<string> = new Set<EarningsSource>(["stripe", "paypal", "manual"]);
const KINDS: ReadonlySet<string> = new Set<MoneyKind>(["sale", "renewal", "refund", "dispute"]);
const WHYS: ReadonlySet<string> = new Set<UnknownWhy>(["unread", "not_reached", "invalid", "too_large"]);
const CURRENCY = /^[a-z]{3}$/;
const SUM_FIELDS = ["salesCents", "renewalCents", "enteredCents", "refundCents", "disputeCents"] as const;
const LINE_KEYS = ["currency", ...SUM_FIELDS, "netCents"];

/** A plain object with exactly these keys, each its own (what JSON.parse makes, nothing more). */
function shaped(value: unknown, keys: readonly string[]): value is Plain {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const wholeFromZero = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** One currency's line, with its difference added again; null when anything is off. */
function lineOf(value: unknown): MonthLine | null {
  if (!shaped(value, LINE_KEYS)) return null;
  if (typeof value.currency !== "string" || !CURRENCY.test(value.currency)) return null;
  if (!SUM_FIELDS.every((field) => wholeFromZero(value[field])) || typeof value.netCents !== "number" || !Number.isSafeInteger(value.netCents)) return null;
  const line = value as unknown as MonthLine;
  const net = line.salesCents + line.renewalCents + line.enteredCents - line.refundCents - line.disputeCents;
  return Number.isSafeInteger(net) && net === line.netCents ? line : null;
}

/** Lines in strictly increasing currency order (one line a currency); null when one is off. */
function linesOf(value: unknown): MonthLine[] | null {
  if (!Array.isArray(value)) return null;
  const lines: MonthLine[] = [];
  for (const item of value) {
    const line = lineOf(item);
    if (!line || (lines.length && !(lines[lines.length - 1].currency < line.currency))) return null;
    lines.push(line);
  }
  return lines;
}

function kindsOf(value: unknown): MoneyKind[] | null {
  if (!Array.isArray(value)) return null;
  const kinds = value.filter((kind): kind is MoneyKind => typeof kind === "string" && KINDS.has(kind));
  return kinds.length === value.length && new Set(kinds).size === kinds.length ? kinds : null;
}

function sourceOf(value: unknown): SourceMonth | null {
  if (typeof value !== "object" || value === null) return null;
  const state = (value as Plain).state;
  if (state === "read") {
    if (!shaped(value, ["source", "state", "lines", "leftOut"]) || typeof value.source !== "string" || !SOURCES.has(value.source)) return null;
    return linesOf(value.lines) && kindsOf(value.leftOut) ? (value as unknown as SourceMonth) : null;
  }
  if (state === "unknown") {
    if (!shaped(value, ["source", "state", "why"]) || typeof value.source !== "string" || !SOURCES.has(value.source)) return null;
    return typeof value.why === "string" && WHYS.has(value.why) ? (value as unknown as SourceMonth) : null;
  }
  return null;
}

/** The sources of a month added within each currency, as the rule adds them; null past exact integers. */
function totalsOf(sources: SourceMonth[]): MonthLine[] | null {
  const by = new Map<string, Record<(typeof SUM_FIELDS)[number], number>>();
  for (const source of sources) {
    if (source.state !== "read") continue;
    for (const line of source.lines) {
      const sums = by.get(line.currency) ?? { salesCents: 0, renewalCents: 0, enteredCents: 0, refundCents: 0, disputeCents: 0 };
      for (const field of SUM_FIELDS) sums[field] += line[field];
      by.set(line.currency, sums);
    }
  }
  const out: MonthLine[] = [];
  for (const [currency, s] of [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const netCents = s.salesCents + s.renewalCents + s.enteredCents - s.refundCents - s.disputeCents;
    const line = { currency, ...s, netCents };
    if (![...SUM_FIELDS.map((f) => line[f]), netCents].every(Number.isSafeInteger)) return null;
    out.push(line);
  }
  return out;
}

const sameLines = (a: MonthLine[], b: MonthLine[]) =>
  a.length === b.length && a.every((line, i) => LINE_KEYS.every((key) => line[key as keyof MonthLine] === b[i][key as keyof MonthLine]));

function monthOf(value: unknown, expected: string, index: number, names: string[]): EarningsMonth | null {
  if (!shaped(value, ["month", "current", "sources", "totals", "leftOut"])) return null;
  if (value.month !== expected || value.current !== (index === 0) || !Array.isArray(value.sources)) return null;
  const sources: SourceMonth[] = [];
  for (const item of value.sources) {
    const source = sourceOf(item);
    if (!source) return null;
    sources.push(source);
  }
  // The same sources, in the same order, every month; each once.
  if (sources.length !== names.length || sources.some((s, i) => s.source !== names[i])) return null;
  // "Entered by you" is not built (design unit 3): the reading gives no entries, so the source is read and empty.
  // A copy with anything else there was not made by this reading, and the file would show what the page hides.
  if (sources.some((s) => s.source === "manual" && !(s.state === "read" && s.lines.length === 0 && s.leftOut.length === 0))) return null;
  const expectedTotals = sources.every((s) => s.state === "read") ? totalsOf(sources) : null;
  if (expectedTotals === null) {
    if (value.totals !== null) return null;
  } else {
    const totals = linesOf(value.totals);
    if (!totals || !sameLines(totals, expectedTotals)) return null;
  }
  // What each read source leaves out, as the rule lists it.
  const expectedLeftOut = sources.flatMap((s) => (s.state === "read" && s.leftOut.length ? [{ source: s.source, kinds: s.leftOut }] : []));
  if (!Array.isArray(value.leftOut) || value.leftOut.length !== expectedLeftOut.length) return null;
  for (let i = 0; i < expectedLeftOut.length; i += 1) {
    const item = value.leftOut[i] as unknown;
    if (!shaped(item, ["source", "kinds"]) || item.source !== expectedLeftOut[i].source) return null;
    const kinds = kindsOf(item.kinds);
    if (!kinds || kinds.length !== expectedLeftOut[i].kinds.length || kinds.some((k, j) => k !== expectedLeftOut[i].kinds[j])) return null;
  }
  return value as unknown as EarningsMonth;
}

/**
 * The kept copy's value read back as the rule's twelve months, only when it
 * is exactly what the rule makes; null otherwise (no file, never a guess).
 */
export function earningsFromCopy(value: unknown): Earnings | null {
  if (!shaped(value, ["timeZone", "at", "since", "months"])) return null;
  if (typeof value.timeZone !== "string" || !wholeFromZero(value.at) || typeof value.since !== "number" || !Array.isArray(value.months)) return null;
  const months = earningsMonths(value.at, value.timeZone);
  if (months.length !== EARNINGS_MONTHS || value.months.length !== EARNINGS_MONTHS || value.since !== monthFloor(months[months.length - 1])) return null;
  const first = value.months[0] as unknown;
  if (typeof first !== "object" || first === null || !Array.isArray((first as Plain).sources)) return null;
  const names = ((first as Plain).sources as unknown[]).map((s) => (typeof s === "object" && s !== null ? (s as Plain).source : null));
  if (!names.every((n): n is string => typeof n === "string" && SOURCES.has(n)) || new Set(names).size !== names.length) return null;
  for (let i = 0; i < EARNINGS_MONTHS; i += 1) if (!monthOf(value.months[i], months[i], i, names)) return null;
  return value as unknown as Earnings;
}

// ---------------------------------------------------------------------------
// Writing the file
// ---------------------------------------------------------------------------

/**
 * An amount in the smallest unit written exactly with the currency's
 * decimals: 2750 dollars-cents "27.50", 2700 yen "2700", 1234 dinar-fils
 * "1.234", -2 cents "-0.02". From the integer's own digits, so no amount is
 * ever rounded.
 */
export function exactAmount(cents: number, currency: string): string {
  if (!Number.isSafeInteger(cents)) throw new Error("an amount that is not exact");
  const digits = decimalsOf(currency);
  const whole = String(Math.abs(cents)).padStart(digits + 1, "0");
  const text = digits ? `${whole.slice(0, -digits)}.${whole.slice(-digits)}` : whole;
  return `${cents < 0 ? "-" : ""}${text}`;
}

const NUMBER = /^-?\d+(\.\d+)?$/;
/** A number cell: only digits, one point and a leading minus, so a spreadsheet reads a number and runs nothing. */
const numberCell = (text: string) => {
  if (!NUMBER.test(text)) throw new Error("an amount cell that is not a plain number");
  return text;
};

type Shared = { month: string; soFar: string; timeZone: string; readAt: string };

function row(shared: Shared, source: string, state: string, line: MonthLine | null, notIncluded: string): string {
  const amounts = line
    ? [line.salesCents, line.renewalCents, line.refundCents, line.disputeCents, line.netCents].map((cents) => numberCell(exactAmount(cents, line.currency)))
    : ["", "", "", "", ""].map(csvCell);
  return [
    csvCell(shared.month),
    csvCell(shared.soFar),
    csvCell(source),
    csvCell(state),
    csvCell(line ? line.currency.toUpperCase() : ""),
    ...amounts,
    csvCell(notIncluded),
    csvCell(shared.timeZone),
    csvCell(shared.readAt),
  ].join(",");
}

const leftOutWords = (items: { source: EarningsSource; kinds: MoneyKind[] }[]) =>
  items.flatMap((item) => item.kinds.map((kind) => `${SOURCE_WORDS[item.source]} ${KIND_WORDS[kind]}`)).join("; ");

/**
 * The months as CSV text, header first, lines ending in CRLF; without the
 * byte-order mark, which the route adds for Excel.
 */
export function earningsCsv(earnings: Earnings): string {
  const readAt = new Date(earnings.at).toISOString();
  const lines = [EARNINGS_CSV_HEADER.map(csvCell).join(",")];
  for (const month of earnings.months) {
    const shared: Shared = { month: month.month, soFar: month.current ? "yes" : "no", timeZone: earnings.timeZone, readAt };
    // "Entered by you" is not built yet (design unit 3): never in the file until it works, as on the page (VR).
    const sources = month.sources.filter((s) => s.source !== "manual");
    for (const source of sources) {
      const name = SOURCE_WORDS[source.source];
      if (source.state === "unknown") {
        lines.push(row(shared, name, EARNINGS_CSV_STATES.unknown, null, ""));
        continue;
      }
      const notIncluded = leftOutWords(source.leftOut.length ? [{ source: source.source, kinds: source.leftOut }] : []);
      if (!source.lines.length) lines.push(row(shared, name, EARNINGS_CSV_STATES.nothing, null, notIncluded));
      for (const line of source.lines) lines.push(row(shared, name, EARNINGS_CSV_STATES.read, line, notIncluded));
    }
    // The sources together, within each currency, only where the page shows them: more than one source.
    if (sources.length > 1) {
      const notIncluded = leftOutWords(month.leftOut.filter((item) => item.source !== "manual"));
      if (!month.totals) lines.push(row(shared, ALL_SOURCES, EARNINGS_CSV_STATES.noTotal, null, ""));
      else if (!month.totals.length) lines.push(row(shared, ALL_SOURCES, EARNINGS_CSV_STATES.nothing, null, notIncluded));
      else for (const line of month.totals) lines.push(row(shared, ALL_SOURCES, EARNINGS_CSV_STATES.read, line, notIncluded));
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** The file's name: the store's handle, "earnings" and the UTC day the months were read. */
export function earningsFileName(handle: string, earnings: Pick<Earnings, "at">): string {
  const safe = /^[a-z0-9][a-z0-9-]{0,62}$/.test(handle) ? handle : "store";
  return `${safe}-earnings-${new Date(earnings.at).toISOString().slice(0, 10)}.csv`;
}
