/**
 * Fees and net by month, and the CSV of fees and net per sale (282 [HG1],
 * unit 2). Pure rules over the same balance transactions as
 * lib/sale-fees-rules.ts, with the months of the earnings page
 * (lib/earnings-by-month.ts) and the shared CSV writer (lib/csv.ts).
 *
 * By month: each line counts in the calendar month it was recorded in, in
 * the store's time zone, so a refund or dispute in a later month lands
 * there and never rewrites the month of its sale. In each month every
 * currency has its own line: sales, gross, Stripe's fee, tax on that fee,
 * application fee, other fees, refunds, disputes, account fees (Stripe Tax
 * and other Stripe fees) and Stripe's own net; currencies are never added
 * together or converted. A month is "read" only when the reading began at
 * or before its floor (monthFloor); otherwise it is "unknown", with no
 * amount at all, never a lower one. A month read with nothing in it is a
 * confirmed zero. A report the rule refuses stays unavailable, and so does
 * an unknown time zone or a line recorded after the reading's own time.
 *
 * The CSV: one row per sale, newest first, then the account fees. Amounts
 * are signed from the creator's side, so the columns of a row add up to its
 * net: fees, refunds and disputes taken are losses, written in parentheses
 * ("(1.75)"), which spreadsheets read as negative numbers and never as a
 * formula. What is unknown is written "Unavailable", never zero.
 *
 * Pure: imports only pure modules.
 */
import { csvLine } from "@/lib/csv";
import { EARNINGS_MONTHS, earningsMonths, monthFloor } from "@/lib/earnings-by-month";
import { plainAmount } from "@/lib/money";
import { readFeeLine, saleFees, type SaleFees, type SaleFeesUnavailable } from "@/lib/sale-fees-rules";

export type FeeMonthLine = {
  currency: string;
  sales: number;
  gross: number;
  stripeFee: number;
  feeTax: number;
  applicationFee: number;
  otherFee: number;
  refunds: number;
  disputes: number;
  /** Stripe Tax fees and other Stripe fees charged to the account (negative). */
  accountFees: number;
  net: number;
};

export type FeeMonth = { month: string; state: "read"; lines: FeeMonthLine[] } | { month: string; state: "unknown" };

export type FeeMonths =
  | { available: true; timeZone: string; months: FeeMonth[] }
  | { available: false; why: SaleFeesUnavailable | "zone" | "late" };

const DATE_LIMIT_MS = 8.64e15;
const inRange = (ms: number): boolean => Number.isFinite(ms) && Math.abs(ms) <= DATE_LIMIT_MS;

function dayFormat(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return null;
  }
}

/** The calendar day (YYYY-MM-DD) an instant falls on in a zone. */
function dayIn(format: Intl.DateTimeFormat, ms: number): string {
  const parts = format.formatToParts(new Date(ms));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The report by month. `reading.since` and `reading.at` are milliseconds:
 * where the reading began and when it was made; `complete` is true only when
 * it reached everything it asked for.
 */
export function saleFeeMonths(
  raws: readonly unknown[],
  reading: { complete: boolean; since: number; at: number },
  timeZone: string,
  count = EARNINGS_MONTHS,
): FeeMonths {
  const report = saleFees(raws, { complete: reading?.complete === true });
  if (!report.available) return { available: false, why: report.why };
  if (!inRange(reading.since) || !inRange(reading.at)) return { available: false, why: "incomplete" };
  const format = dayFormat(timeZone);
  const months = earningsMonths(reading.at, timeZone, count);
  if (!format || !months.length) return { available: false, why: "zone" };

  const shown = new Set(months);
  const sums = new Map<string, Map<string, FeeMonthLine>>();
  for (const raw of raws) {
    const line = readFeeLine(raw);
    // saleFees read every line already; this is the same rule, so null cannot come back here.
    if (line === null || line === "other") continue;
    const ms = line.at * 1000;
    if (ms > reading.at) return { available: false, why: "late" };
    if (!inRange(ms)) return { available: false, why: "unreadable" };
    const month = dayIn(format, ms).slice(0, 7);
    if (!shown.has(month)) continue;
    const byCurrency = sums.get(month) ?? new Map<string, FeeMonthLine>();
    const sum = byCurrency.get(line.currency) ?? {
      currency: line.currency, sales: 0, gross: 0, stripeFee: 0, feeTax: 0, applicationFee: 0, otherFee: 0,
      refunds: 0, disputes: 0, accountFees: 0, net: 0,
    };
    if (line.kind === "sale") {
      sum.sales += 1;
      sum.gross += line.amount;
    } else if (line.kind === "refund") sum.refunds += line.amount;
    else if (line.kind === "dispute") sum.disputes += line.amount;
    if (line.sale === null) sum.accountFees += line.net;
    else {
      sum.stripeFee += line.stripeFee;
      sum.feeTax += line.feeTax;
      sum.applicationFee += line.applicationFee;
      sum.otherFee += line.otherFee;
    }
    sum.net += line.net;
    byCurrency.set(line.currency, sum);
    sums.set(month, byCurrency);
  }

  return {
    available: true,
    timeZone,
    months: months.map((month): FeeMonth => {
      if (reading.since > monthFloor(month)) return { month, state: "unknown" };
      const lines = [...(sums.get(month)?.values() ?? [])].sort((a, b) => (a.currency < b.currency ? -1 : 1));
      return { month, state: "read", lines };
    }),
  };
}

export const SALE_FEES_CSV_HEADER = [
  "Date", "Sale", "Currency", "Gross", "Stripe fee", "Tax on Stripe fee", "Application fee", "Other fees", "Refunds", "Disputes", "Net",
] as const;

const UNAVAILABLE = "Unavailable";

/** An amount for the spreadsheet: every decimal, a loss in parentheses, unknown said. */
export function amountCell(amount: number | null, currency: string): string {
  if (amount === null || !Number.isSafeInteger(amount)) return UNAVAILABLE;
  return amount < 0 ? `(${plainAmount(-amount, currency)})` : plainAmount(amount, currency);
}

const ACCOUNT_FEE_WORDS = { taxFees: "Stripe Tax fees", stripeFees: "Other Stripe fees" } as const;

/** The CSV of fees and net per sale; null when the report is unavailable or the zone unknown. */
export function saleFeesCsv(report: SaleFees, timeZone: string): string | null {
  const format = dayFormat(timeZone);
  if (!report.available || !format) return null;
  const lines = [csvLine([...SALE_FEES_CSV_HEADER])];
  for (const row of report.rows) {
    const c = row.currency;
    const date = row.at !== null && inRange(row.at * 1000) ? dayIn(format, row.at * 1000) : UNAVAILABLE;
    lines.push(
      csvLine([
        date, row.sale, c.toUpperCase(), amountCell(row.gross, c), amountCell(-row.stripeFee, c), amountCell(-row.feeTax, c),
        amountCell(-row.applicationFee, c), amountCell(-row.otherFee, c), amountCell(row.refunds, c), amountCell(row.disputes, c),
        amountCell(row.net, c),
      ]),
    );
  }
  for (const fees of report.accountFees) {
    for (const key of ["taxFees", "stripeFees"] as const) {
      if (fees[key] === 0) continue;
      lines.push(csvLine(["", ACCOUNT_FEE_WORDS[key], fees.currency.toUpperCase(), "", "", "", "", "", "", "", amountCell(fees[key], fees.currency)]));
    }
  }
  return lines.join("\n");
}
