/**
 * HMRC's period rates of exchange, read for UK VAT on a sale in another currency than pounds (789 [IV1] step 3,
 * unit 7). VAT Notice 700, 7.6 (25/06/2026, force of law under VAT Act 1994 Sch. 6 para 11): the VAT is "expressed in
 * sterling", converted at the UK market selling rate at the time of the supply or, adopted for all supplies, "the
 * period rate of exchange published by HMRC for customs purposes". Marktmorgen adopts the period rate: one rate per
 * calendar month and currency, published by HMRC before the month starts, given as units of the currency per £1.
 *
 * Empty on purpose. HMRC publishes the monthly rates on the UK Trade Tariff service
 * (https://www.trade-tariff.service.gov.uk/exchange_rates); they were not read in the session that built this unit (the
 * download was refused there), so no row is written and every UK sale in another currency stays refused. A row is
 * added only as HMRC published it: the month, the currency, the rate exactly as written, the https page it was read
 * on and the day it was read. A month or currency with no row is unknown, never a guess and never another source's rate.
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

export const HMRC_PERIOD_RATES: readonly HmrcPeriodRate[] = Object.freeze([]);

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
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
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
