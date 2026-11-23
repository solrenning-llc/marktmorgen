/**
 * HMRC's period rates of exchange, read for UK VAT on a sale in another currency than pounds (789 [IV1] step 3,
 * unit 7). VAT Notice 700, 7.6 (25/06/2026, force of law under VAT Act 1994 Sch. 6 para 11): the VAT is "expressed in
 * sterling", converted at the UK market selling rate at the time of the supply or, adopted for all supplies, "the
 * period rate of exchange published by HMRC for customs purposes". Marktmorgen adopts the period rate: one rate per
 * calendar month and currency, published by HMRC before the month starts, given as units of the currency per £1.
 *
 * HMRC publishes the monthly rates on the UK Trade Tariff service (https://www.trade-tariff.service.gov.uk/exchange_rates).
 * The owner authorized downloading that public publication (OWNER-20261121-HHMM-HMRC-EXCHANGE-RATES, 21/11/2026): no
 * account, no key, no terms. November and December 2026 were downloaded on 21/11/2026 and are kept byte for byte in
 * docs/hmrc-exchange-rates/, each with its exact address and SHA-256 (HMRC_RATE_FILES); tests/hmrc-period-rates-source
 * .test.ts checks every row against its file. A row is added only as HMRC published it; a month or currency with no
 * row is unknown, never a guess and never another source's rate. Before opening, the rows are read again at the source.
 * Pure: no IO.
 */
import type { UkSterlingRate } from "@/lib/uk-vat";

export type HmrcPeriodRate = Readonly<{
  /** The calendar month the rate applies to, YYYY-MM. */
  month: string;
  /** ISO 4217, upper case; never GBP. */
  currency: string;
  /** Units of the currency per £1, exactly as HMRC wrote it. */
  perPound: string;
  /** The https page the rate was read on, and the UTC day it was read. */
  source: string;
  readOn: string;
}>;

/** HMRC's monthly files as downloaded, kept byte for byte in docs/hmrc-exchange-rates/ (tests/hmrc-period-rates-source.test.ts). */
export type HmrcRateFile = Readonly<{ month: string; path: string; source: string; readOn: string; sha256: string }>;

export const HMRC_RATE_FILES: readonly HmrcRateFile[] = Object.freeze([
  { month: "2026-11", path: "docs/hmrc-exchange-rates/monthly_csv_2026-11.csv", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21", sha256: "0938d0c8ecb918aa56643b1e4d0db7b117818094bddb8ea93b0703005fbe1676" },
  { month: "2026-12", path: "docs/hmrc-exchange-rates/monthly_csv_2026-12.csv", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21", sha256: "a16e7167467059dda4e4984002824543cc8d08048e66536fd034a6c7be56e55d" },
]);

/** Every store currency written in hundredths but pounds, for each month in HMRC_RATE_FILES, as HMRC wrote the rate. */
export const HMRC_PERIOD_RATES: readonly HmrcPeriodRate[] = Object.freeze([
  { month: "2026-11", currency: "AUD", perPound: "1.9052", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "CAD", perPound: "1.8822", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "CHF", perPound: "1.1046", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "DKK", perPound: "8.9172", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "EUR", perPound: "1.1930", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "HKD", perPound: "10.5124", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "MXN", perPound: "24.7810", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "NOK", perPound: "12.5386", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "NZD", perPound: "2.3544", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "PLN", perPound: "5.2056", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "SEK", perPound: "13.2475", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "SGD", perPound: "1.7112", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-11", currency: "USD", perPound: "1.3396", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-11.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "AUD", perPound: "1.9556", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "CAD", perPound: "1.8828", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "CHF", perPound: "1.1090", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "DKK", perPound: "8.9719", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "EUR", perPound: "1.2003", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "HKD", perPound: "10.3241", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "MXN", perPound: "24.3911", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "NOK", perPound: "12.7389", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "NZD", perPound: "2.3947", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "PLN", perPound: "5.2978", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "SEK", perPound: "13.3671", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "SGD", perPound: "1.6972", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
  { month: "2026-12", currency: "USD", perPound: "1.3158", source: "https://www.trade-tariff.service.gov.uk/api/v2/exchange_rates/files/monthly_csv_2026-12.csv", readOn: "2026-11-21" },
]);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RATE = /^(0|[1-9]\d{0,6})(\.\d{1,6})?$/;
const CURRENCY = /^[A-Z]{3}$/;

function realDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function httpsSource(value: unknown): boolean {
  // The page's own address as written: "https://" and then a domain, so "https:x" and "https:///x", which `new URL`
  // reads as host "x", name no page (Claude 2's NIT on #5024, 7061724274).
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) && value.slice("https://".length).toLowerCase().startsWith(url.hostname);
  } catch {
    return false;
  }
}

function positiveRate(value: unknown): value is string {
  return typeof value === "string" && RATE.test(value) && /[1-9]/.test(value);
}

/**
 * HMRC's period rate for a sale in `currency` supplied on `day` (YYYY-MM-DD), as lib/uk-vat.ts reads it, or null when
 * the month has no single readable row for that currency read on or before the day. Two rows that disagree are unknown.
 */
export function hmrcPeriodRate(currency: string, day: string, table: readonly HmrcPeriodRate[] = HMRC_PERIOD_RATES): UkSterlingRate | null {
  const code = typeof currency === "string" ? currency.toUpperCase() : "";
  if (!CURRENCY.test(code) || code === "GBP" || !realDay(day) || !Array.isArray(table)) return null;
  const month = day.slice(0, 7);
  const rows = table.filter((row) => row && row.currency === code && row.month === month);
  if (rows.length === 0) return null;
  if (rows.some((row) => !MONTH.test(row.month) || !positiveRate(row.perPound) || !httpsSource(row.source) || !realDay(row.readOn) || row.readOn > day)) return null;
  const rates = new Set(rows.map((row) => row.perPound));
  if (rates.size !== 1) return null;
  const sources = new Set(rows.map((row) => row.source));
  if (sources.size !== 1) return null;
  return { perPound: rows[0].perPound, basis: "hmrc-period", day, source: rows[0].source };
}
