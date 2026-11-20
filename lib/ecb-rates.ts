/**
 * EU VAT, unit 2 (IVA, 14/11/2026): the European Central Bank's euro reference rates, as the non-Union OSS return and
 * the art. 230 invoice line read them. Pure parsing plus one bounded request; nothing is stored, and nothing calls the
 * request yet (the return is built for the owner on demand, a later unit).
 *
 * Sources, read on 14/11/2026:
 *   - ECB Data Portal API, https://data-api.ecb.europa.eu/service/data/EXR/D.<CUR>.EUR.SP00.A?format=csvdata: one
 *     row per working day, TIME_PERIOD (YYYY-MM-DD) and OBS_VALUE (units of the currency per euro, "ECB reference
 *     exchange rate, [...] 2.15 pm (C.E.T.)"); days without publication have no row (2026-10-03 and 2026-10-04,
 *     a weekend, were absent from the answer read).
 *   - OSS guide, revised July 2026 (vat-one-stop-shop.ec.europa.eu, Guides), Part 2, question 15: "use the exchange
 *     rate as published by the European Central Bank on the last date of the tax period".
 *   - Directive 2006/112/EC art. 366(2) (legislation.gov.uk/eudr/2006/112/article/366, the EU text as at 31/12/2020):
 *     "applying the exchange rates published by the European Central Bank for that day, or, if there is no publication
 *     on that day, on the next day of publication".
 */
export const ECB_DATA_API = "https://data-api.ecb.europa.eu/service/data/EXR";
/** The one request's whole budget. */
export const ECB_TIMEOUT_MS = 8000;
/** Days after the period's last day within which the next publication must be found; past it the rate is unknown. */
export const ECB_NEXT_PUBLICATION_DAYS = 10;
const MOST_BYTES = 2_000_000;

/** Currency → day (YYYY-MM-DD) → units per euro as the ECB published it (a decimal string, never a float). */
export type EcbRates = ReadonlyMap<string, ReadonlyMap<string, string>>;

const CURRENCY = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RATE = /^(0|[1-9]\d{0,6})(\.\d{1,6})?$/;
const realDay = (value: string) => {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};

/** The address of the daily reference rates of `currencies` against the euro from `from` to `to`, as CSV. */
export function ecbRatesUrl(currencies: readonly string[], from: string, to: string): string | null {
  if (!Array.isArray(currencies) || currencies.length === 0 || currencies.some((c) => !CURRENCY.test(c) || c === "EUR") || !realDay(from) || !realDay(to) || from > to) return null;
  return `${ECB_DATA_API}/D.${[...new Set(currencies)].sort().join("+")}.EUR.SP00.A?startPeriod=${from}&endPeriod=${to}&format=csvdata`;
}

/** Splits one CSV line, honouring quoted fields ("..." with "" inside). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cell); cell = ""; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}

/**
 * The rates in an ECB CSV answer, or null when it is not one: a missing column, a row that is not a daily euro
 * reference rate, a day or value that does not read, or the same day given twice with different values.
 */
export function readEcbCsv(text: unknown): EcbRates | null {
  if (typeof text !== "string" || text.length > MOST_BYTES) return null;
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  const head = cells(lines[0]);
  const at = (name: string) => head.indexOf(name);
  const col = { freq: at("FREQ"), cur: at("CURRENCY"), denom: at("CURRENCY_DENOM"), type: at("EXR_TYPE"), suffix: at("EXR_SUFFIX"), day: at("TIME_PERIOD"), value: at("OBS_VALUE") };
  if (Object.values(col).some((i) => i < 0)) return null;
  const rates = new Map<string, Map<string, string>>();
  for (const line of lines.slice(1)) {
    const row = cells(line);
    if (row[col.freq] !== "D" || row[col.denom] !== "EUR" || row[col.type] !== "SP00" || row[col.suffix] !== "A") return null;
    const currency = row[col.cur];
    const day = row[col.day];
    const value = row[col.value];
    if (!CURRENCY.test(currency) || !realDay(day) || !RATE.test(value) || Number(value) <= 0) return null;
    const byDay = rates.get(currency) ?? new Map<string, string>();
    if (byDay.has(day) && byDay.get(day) !== value) return null;
    byDay.set(day, value);
    rates.set(currency, byDay);
  }
  return rates;
}

/**
 * The rate art. 366(2) asks for a period that ends on `lastDay`: the one published that day, or else on the next day
 * of publication, within ECB_NEXT_PUBLICATION_DAYS. Euro is 1. Null when it is not in `rates`: never a nearby guess.
 */
export function periodEndRate(rates: EcbRates, currency: string, lastDay: string): { perEuro: string; day: string } | null {
  if (!realDay(lastDay)) return null;
  if (currency === "EUR") return { perEuro: "1", day: lastDay };
  if (!(rates instanceof Map)) return null;
  const byDay = rates.get(currency);
  if (!(byDay instanceof Map)) return null;
  const start = Date.parse(`${lastDay}T00:00:00Z`);
  for (let i = 0; i <= ECB_NEXT_PUBLICATION_DAYS; i += 1) {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const value = byDay.get(day);
    if (value !== undefined) return { perEuro: value, day };
  }
  return null;
}

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; text: () => Promise<string> }>;

/** One request for the rates; null on any failure (network, status, size, a body that does not read). Never throws. */
export async function fetchEcbRates(currencies: readonly string[], from: string, to: string, fetcher?: Fetcher): Promise<EcbRates | null> {
  const get: Fetcher = fetcher ?? ((u, init) => fetch(u, init));
  try {
    const url = ecbRatesUrl(currencies, from, to);
    if (!url) return null;
    const response = await get(url, { headers: { accept: "text/csv" }, signal: AbortSignal.timeout(ECB_TIMEOUT_MS) });
    if (response.status !== 200) return null;
    return readEcbCsv(await response.text());
  } catch {
    return null;
  }
}
