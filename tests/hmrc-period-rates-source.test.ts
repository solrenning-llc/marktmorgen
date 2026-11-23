/**
 * 789 [IV1] step 3, unit 7 (owner OWNER-20261121-HHMM-HMRC-EXCHANGE-RATES, 21/11/2026): HMRC's monthly exchange rates,
 * downloaded from the public publication on the UK Trade Tariff service and kept byte for byte in
 * docs/hmrc-exchange-rates/, checked here against lib/hmrc-period-rates.ts. It holds that:
 *   - each kept file is the one downloaded: its SHA-256 is the one recorded in HMRC_RATE_FILES;
 *   - every row of HMRC_PERIOD_RATES is in its month's file, the same currency and the same rate, and the file's dates
 *     cover exactly that calendar month; its source is the file's exact address and it was read on the recorded day;
 *   - every store currency written in hundredths (lib/money.ts), but pounds, has a row for every recorded month, and
 *     nothing else has one (yen is not in hundredths);
 *   - a month with no file has no row, so a UK sale in another currency in that month is refused.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CURRENCIES, decimalsOf } from "@/lib/money";
import { HMRC_PERIOD_RATES, HMRC_RATE_FILES, hmrcPeriodRate } from "@/lib/hmrc-period-rates";
import { done, is, part } from "./check";

function rowsOf(csv: string): Map<string, { rate: string; start: string; end: string }[]> {
  const out = new Map<string, { rate: string; start: string; end: string }[]>();
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  if (header !== "Country/Territories,Currency,Currency Code,Currency Units per £1,Start date,End date") throw new Error(`unexpected header: ${header}`);
  for (const line of lines) {
    const cells = line.split(",");
    if (cells.length !== 6) throw new Error(`unexpected line: ${line}`);
    const [, , code, rate, start, end] = cells;
    out.set(code, [...(out.get(code) ?? []), { rate, start, end }]);
  }
  return out;
}
/** "01/11/2026" → "2026-11-01". */
const iso = (d: string) => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`;
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

function main(): void {
  part("Each kept file is the one downloaded");
  is("two months are recorded", HMRC_RATE_FILES.map((f) => f.month), ["2026-11", "2026-12"]);
  const files = new Map<string, Map<string, { rate: string; start: string; end: string }[]>>();
  for (const file of HMRC_RATE_FILES) {
    const bytes = readFileSync(file.path);
    is(`${file.month}: the SHA-256 recorded is the file's`, createHash("sha256").update(bytes).digest("hex"), file.sha256);
    is(`${file.month}: the exact address of HMRC's monthly file`, file.source, `https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_${file.month}.csv`);
    is(`${file.month}: kept under its month`, file.path, `docs/hmrc-exchange-rates/monthly_csv_${file.month}.csv`);
    files.set(file.month, rowsOf(bytes.toString("utf8")));
  }

  part("Every row is in its month's file, rate and dates exactly");
  let inFile = true;
  for (const row of HMRC_PERIOD_RATES) {
    const file = HMRC_RATE_FILES.find((f) => f.month === row.month);
    const found = files.get(row.month)?.get(row.currency) ?? [];
    const same = found.length > 0 && found.every((r) => r.rate === row.perPound && iso(r.start) === `${row.month}-01` && iso(r.end) === lastDay(row.month));
    if (!file || !same || row.source !== file.source || row.readOn !== file.readOn) {
      inFile = false;
      console.log(`  not as in the file: ${JSON.stringify(row)}`);
    }
  }
  is("each of the table's rows", inFile, true);

  part("Every store currency in hundredths but pounds, every recorded month, and nothing else");
  const expected = CURRENCIES.map((c) => c.code).filter((c) => c !== "gbp" && decimalsOf(c) === 2).map((c) => c.toUpperCase()).sort();
  for (const file of HMRC_RATE_FILES) {
    is(`${file.month}: the currencies with a row`, HMRC_PERIOD_RATES.filter((r) => r.month === file.month).map((r) => r.currency).sort(), expected);
  }
  is("no yen row", HMRC_PERIOD_RATES.some((r) => r.currency === "JPY"), false);

  part("Read as the checkout reads them");
  is("euros on 1 December 2026", hmrcPeriodRate("eur", "2026-12-01")?.perPound, files.get("2026-12")!.get("EUR")![0].rate);
  is("dollars on 30 November 2026", hmrcPeriodRate("usd", "2026-11-30")?.perPound, files.get("2026-11")!.get("USD")![0].rate);
  is("January 2027 has no file: unknown", hmrcPeriodRate("eur", "2027-01-04"), null);
  // Claude 2's NIT on #5024 (7061724274), the same check here: a source written "https:x" or "https:///x", which `new URL`
  // reads as host "x", is no address of a page, so the row gives no rate.
  const december = HMRC_PERIOD_RATES.filter((row) => row.month === "2026-12");
  // Claude 5's NIT on #5334 (7099077097): an IP literal such as 1.2.3.4 is dotted but names no domain to review.
  for (const source of ["https:x", "https:///x", "https://x/file.csv", "https://1.2.3.4/file.csv"]) {
    is(`a source written ${source}: unknown`, hmrcPeriodRate("eur", "2026-12-01", december.map((row) => ({ ...row, source }))), null);
  }
  is("the exact HTTPS address still gives the rate", hmrcPeriodRate("eur", "2026-12-01", december)?.perPound, files.get("2026-12")!.get("EUR")![0].rate);

  done();
}

main();
