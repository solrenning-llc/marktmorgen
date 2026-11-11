/**
 * Fees and net by month, and the CSV of fees and net per sale (282 [HG1],
 * unit 2; lib/sale-fees-months.ts). Synthetic Stripe balance transactions
 * only. Checked:
 *
 *   - each line counts in the month it was recorded in the store's time zone
 *     (a refund in a later month lands there, never rewriting the sale's month);
 *   - a month is "read" only when the reading began at or before its floor;
 *     a month read with nothing in it is a confirmed zero, an unread one has
 *     no amounts at all;
 *   - currencies stay apart; account fees count in their month;
 *   - every month line adds up to the net Stripe recorded;
 *   - unavailable stays unavailable: a report the rule refuses, an unknown
 *     time zone or a line after the reading's own time;
 *   - the CSV: one row per sale with signed amounts that add up to the net,
 *     losses in parentheses (never a cell a spreadsheet reads as a formula),
 *     "Unavailable" where a sale is outside the reading, account fees apart.
 */
import { EARNINGS_MONTHS, monthFloor } from "@/lib/earnings-by-month";
import { saleFees } from "@/lib/sale-fees-rules";
import { SALE_FEES_CSV_HEADER, amountCell, saleFeeMonths, saleFeesCsv, type FeeMonths } from "@/lib/sale-fees-months";
import { done, is, part } from "./check";

const ZONE = "America/New_York";
let n = 0;
type Txn = Record<string, unknown>;
type Detail = { amount: number; type: string };

function txn(o: { type: string; category: string; amount: number; at: number; currency?: string; source?: unknown; details?: Detail[] }): Txn {
  n += 1;
  const currency = o.currency ?? "usd";
  const fee_details = (o.details ?? []).map((d) => ({ amount: d.amount, currency, type: d.type }));
  const fee = fee_details.reduce((s, d) => s + d.amount, 0);
  return {
    id: `txn_${n}`, object: "balance_transaction", amount: o.amount, currency, fee, fee_details, net: o.amount - fee,
    type: o.type, reporting_category: o.category, source: o.source ?? null, created: Math.floor(o.at / 1000),
  };
}
const sale = (charge: string, amount: number, fee: number, at: number, currency = "usd") =>
  txn({ type: "charge", category: "charge", amount, at, currency, source: charge, details: [{ amount: fee, type: "stripe_fee" }] });
const refund = (charge: string, amount: number, at: number) =>
  txn({ type: "refund", category: "refund", amount: -amount, at, source: { id: "re_1", charge } });
const taxFee = (amount: number, at: number) => txn({ type: "tax_fee", category: "tax", amount: -amount, at });

// New York: 2026-10-31 23:30 local is 2026-11-01 03:30 UTC.
const OCT_LATE_LOCAL = Date.UTC(2026, 10, 1, 3, 30);
const NOV_5 = Date.UTC(2026, 10, 5, 15);
const SEP_10 = Date.UTC(2026, 8, 10, 15);
const AT = Date.UTC(2026, 10, 11, 15);

function monthOf(r: FeeMonths, month: string): unknown {
  return r.available ? r.months.find((m) => m.month === month) : r.why;
}

function main(): void {
  const list = [
    sale("ch_a", 5000, 175, OCT_LATE_LOCAL),
    sale("ch_b", 2000, 88, NOV_5),
    sale("ch_e", 1000, 59, NOV_5, "eur"),
    refund("ch_a", 5000, NOV_5 + 60_000),
    taxFee(25, NOV_5),
    sale("ch_s", 700, 50, SEP_10),
  ];
  const since = monthFloor("2025-12");
  const r = saleFeeMonths(list, { complete: true, since, at: AT }, ZONE);

  part("Each line in the month it was recorded, in the store's time zone");
  is("twelve months, newest first", r.available ? r.months.map((m) => m.month) : r.why, [
    "2026-11", "2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01", "2025-12",
  ]);
  is("a sale at 23:30 on October 31 in New York is October's, though it is November in UTC", monthOf(r, "2026-10"), {
    month: "2026-10", state: "read",
    lines: [{ currency: "usd", sales: 1, gross: 5000, stripeFee: 175, feeTax: 0, applicationFee: 0, otherFee: 0, refunds: 0, disputes: 0, accountFees: 0, net: 4825 }],
  });
  is("November: its refund of October's sale lands here, currencies apart, the Stripe Tax fee in its month", monthOf(r, "2026-11"), {
    month: "2026-11", state: "read",
    lines: [
      { currency: "eur", sales: 1, gross: 1000, stripeFee: 59, feeTax: 0, applicationFee: 0, otherFee: 0, refunds: 0, disputes: 0, accountFees: 0, net: 941 },
      { currency: "usd", sales: 1, gross: 2000, stripeFee: 88, feeTax: 0, applicationFee: 0, otherFee: 0, refunds: -5000, disputes: 0, accountFees: -25, net: 2000 - 88 - 5000 - 25 },
    ],
  });
  is("a month read with nothing in it is a confirmed zero", monthOf(r, "2026-08"), { month: "2026-08", state: "read", lines: [] });
  if (r.available) {
    const all = r.months.flatMap((m) => (m.state === "read" ? m.lines : []));
    is("every month line adds up to Stripe's net", all.every((l) => l.net === l.gross - l.stripeFee - l.feeTax - l.applicationFee - l.otherFee + l.refunds + l.disputes + l.accountFees), true);
  }

  part("A month is read only when the reading reached its floor");
  const late = saleFeeMonths(list, { complete: true, since: monthFloor("2026-09") + 1, at: AT }, ZONE);
  is("a reading that began an instant after September's floor: September unknown, no amounts", monthOf(late, "2026-09"), { month: "2026-09", state: "unknown" });
  is("and every older month unknown too", late.available ? late.months.slice(2).every((m) => m.state === "unknown") : false, true);
  is("October still read", late.available ? late.months[1].state : null, "read");

  part("Unavailable stays unavailable");
  is("an incomplete reading", saleFeeMonths(list, { complete: false, since, at: AT }, ZONE), { available: false, why: "incomplete" });
  is("a line the rule cannot read", saleFeeMonths([...list, { ...list[0], net: 1 }], { complete: true, since, at: AT }, ZONE), { available: false, why: "unreadable" });
  is("an unknown time zone", saleFeeMonths(list, { complete: true, since, at: AT }, "Mars/Olympus"), { available: false, why: "zone" });
  is("a line after the reading's own time", saleFeeMonths([...list, sale("ch_z", 100, 1, AT + 1000)], { complete: true, since, at: AT }, ZONE), { available: false, why: "late" });
  is("an unreadable reading time", saleFeeMonths(list, { complete: true, since: Number.NaN, at: AT }, ZONE), { available: false, why: "incomplete" });
  is("months asked for are the earnings page's", EARNINGS_MONTHS, 12);

  part("Amount cells");
  is("dollars with every decimal", amountCell(5000, "usd"), "50.00");
  is("a loss in parentheses, which spreadsheets read as negative and never as a formula", amountCell(-1234, "usd"), "(12.34)");
  is("yen without decimals", amountCell(-2700, "jpy"), "(2700)");
  is("zero", amountCell(0, "eur"), "0.00");
  is("unknown is said", amountCell(null, "usd"), "Unavailable");

  part("The CSV, one row per sale");
  const report = saleFees([sale("ch_a", 5000, 175, OCT_LATE_LOCAL), refund("ch_a", 1000, NOV_5), refund("ch_old", 300, NOV_5), taxFee(25, NOV_5)], { complete: true });
  const csv = saleFeesCsv(report, ZONE);
  is("header, sales newest first, then account fees", csv?.split("\n"), [
    SALE_FEES_CSV_HEADER.map((h) => `"${h}"`).join(","),
    `"2026-10-31","ch_a","USD","50.00","(1.75)","0.00","0.00","0.00","(10.00)","0.00","38.25"`,
    `"Unavailable","ch_old","USD","Unavailable","0.00","0.00","0.00","0.00","(3.00)","0.00","Unavailable"`,
    `"","Stripe Tax fees","USD","","","","","","","","(0.25)"`,
  ]);
  is("the header names every column", SALE_FEES_CSV_HEADER, ["Date", "Sale", "Currency", "Gross", "Stripe fee", "Tax on Stripe fee", "Application fee", "Other fees", "Refunds", "Disputes", "Net"]);
  is("no cell starts like a formula", csv?.split("\n").every((l) => !/(^|,)"[=+\-@]/.test(l)), true);
  is("an unavailable report gives no file", saleFeesCsv({ available: false, why: "unreadable" }, ZONE), null);
  is("an unknown time zone gives no file", saleFeesCsv(report, "Mars/Olympus"), null);
  is("nothing sold: the header alone", saleFeesCsv(saleFees([], { complete: true }), ZONE), SALE_FEES_CSV_HEADER.map((h) => `"${h}"`).join(","));

  done();
}

main();
