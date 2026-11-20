/**
 * EU VAT under art. 9a, part 2 of the build, unit 3: the VAT added on top of the buyer's price (docs/eu-vat-article-9a.md).
 * Pure: imports only the list of Member States.
 *
 * The owner's design: the VAT is added on top of the buyer's price (or taken from the creator's payout), never from
 * Marktmorgen's commission. So the price and Marktmorgen's share never change here; the VAT is its own amount.
 *
 * Rates. A rate is used only from EU_VAT_RATES, each with the official source it was read from and the day it was read,
 * never typed from memory. The table holds the standard rate of each of the 27 Member States as the Commission's TEDB
 * gave it on 13/11/2026 (docs/eu-vat-official-sources-2026-11-13.md, branch claude2/eu-vat-official-sources @1251b48e68,
 * C2-20261113-1445-IVA-3), with the TEDB's own situation date per line. It is used only until EU_VAT_RATES_VALID_UNTIL:
 * past it no rate is given, so no EU sale is collected on a table nobody read again. A country with no valid record
 * is no sale (vatOnTop answers null), never a default rate. Only the standard rate is modelled: recorded courses and
 * audiobooks take it everywhere, and so do e-books until a classification says a product qualifies for a reduced rate
 * (Directive annex III, point 6) that its own sourced record confirms; the standard rate never understates the tax.
 *
 * Amount. Directive 2006/112/EC art. 73: the taxable amount is everything the consumer pays for the supply, here the
 * price before VAT. The VAT is price × rate, rounded half up to the currency's smallest unit (one rounding per sale, on
 * the line total). Nothing here records a treatment or opens a sale.
 */
import { EU_VAT_COUNTRIES } from "@/lib/eu-vat-supply";

export type EuVatRate = {
  /** ISO 3166-1 alpha-2 of the Member State. */
  country: string;
  /** The standard rate, in hundredths of a percent (19% = 1900). */
  basisPoints: number;
  /** The official page the rate was read from. */
  source: string;
  /** The day it was read, YYYY-MM-DD. */
  readOn: string;
  /** The date of the situation the source recorded for that day (the TEDB's `situationOn`), YYYY-MM-DD. */
  situationOn?: string;
};

/** The Commission's Taxes in Europe Database, read through its official service (docs/eu-vat-official-sources-2026-11-13.md, 0). */
const TEDB = "https://ec.europa.eu/taxation_customs/tedb/";
const tedb = (country: string, basisPoints: number, situationOn: string): EuVatRate => ({ country, basisPoints, source: TEDB, readOn: "2026-11-13", situationOn });

/** The standard rate of each Member State on 13/11/2026 (TEDB, "STANDARD" line of the main territory; Greece is GR here, EL in the TEDB). */
export const EU_VAT_RATES: readonly EuVatRate[] = [
  tedb("AT", 2000, "2026-07-01"),
  tedb("BE", 2100, "2026-07-01"),
  tedb("BG", 2000, "2026-07-01"),
  tedb("CY", 1900, "2026-01-01"),
  tedb("CZ", 2100, "2026-07-01"),
  tedb("DE", 1900, "2026-07-01"),
  tedb("DK", 2500, "2026-07-01"),
  tedb("EE", 2400, "2026-07-01"),
  tedb("ES", 2100, "2026-07-01"),
  tedb("FI", 2550, "2026-07-01"),
  tedb("FR", 2000, "2026-07-01"),
  tedb("GR", 2400, "2026-01-01"),
  tedb("HR", 2500, "2026-07-01"),
  tedb("HU", 2700, "2026-07-01"),
  tedb("IE", 2300, "2026-07-01"),
  tedb("IT", 2200, "2026-07-01"),
  tedb("LT", 2100, "2026-07-01"),
  tedb("LU", 1700, "2026-07-01"),
  tedb("LV", 2100, "2026-07-01"),
  tedb("MT", 1800, "2026-07-01"),
  tedb("NL", 2100, "2026-07-01"),
  tedb("PL", 2300, "2026-07-01"),
  tedb("PT", 2300, "2026-01-01"),
  tedb("RO", 2100, "2026-07-01"),
  tedb("SE", 2500, "2026-07-01"),
  tedb("SI", 2200, "2026-07-01"),
  tedb("SK", 2300, "2026-07-01"),
];

/**
 * The last day the official table may be used: the TEDB records each Member State's situation from 1 January and
 * 1 July, so the table read on 13/11/2026 is good until the next situation date, and must be read again before it.
 */
export const EU_VAT_RATES_VALID_UNTIL = "2026-12-31";
const expired = (table: readonly EuVatRate[], today: Date) => table === EU_VAT_RATES && today.toISOString().slice(0, 10) > EU_VAT_RATES_VALID_UNTIL;

/** The highest standard rate any Member State may set is far below this; anything above is a typing error. */
const MAX_BASIS_POINTS = 3500;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (value: string) => {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

function recordProblems(record: EuVatRate): string[] {
  const out: string[] = [];
  const name = typeof record?.country === "string" ? record.country : "?";
  if (!EU_VAT_COUNTRIES.has(name)) out.push(`${name}: not a Member State`);
  if (!Number.isSafeInteger(record?.basisPoints) || record.basisPoints <= 0 || record.basisPoints > MAX_BASIS_POINTS) out.push(`${name}: rate`);
  if (typeof record?.source !== "string" || !/^https:\/\/\S+$/.test(record.source)) out.push(`${name}: source`);
  if (typeof record?.readOn !== "string" || !realDay(record.readOn)) out.push(`${name}: readOn`);
  return out;
}

/** Every problem with a rate table: each record whole, one per country. Empty means every record may be used. */
export function euVatRateProblems(table: readonly EuVatRate[] = EU_VAT_RATES, today = new Date()): string[] {
  const out: string[] = [];
  if (expired(table, today)) out.push(`the official rate table is past its review date, ${EU_VAT_RATES_VALID_UNTIL}`);
  const seen = new Map<string, number>();
  for (const record of table) {
    out.push(...recordProblems(record));
    const name = typeof record?.country === "string" ? record.country : "?";
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  for (const [name, count] of seen) if (count > 1) out.push(`${name}: recorded more than once`);
  return out;
}

/** The one valid rate of a country, or null: missing, broken or recorded more than once is no rate. */
function rateOf(country: string, table: readonly EuVatRate[]): EuVatRate | null {
  const found = table.filter((record) => record?.country === country);
  if (found.length !== 1 || recordProblems(found[0]).length > 0) return null;
  return found[0];
}

export type VatOnTop = { priceCents: number; vatCents: number; totalCents: number; basisPoints: number; country: string };

/** The VAT added on top of `priceCents` for a consumer in `country`, or null: no sourced rate, or a price that is not whole. */
export function vatOnTop(priceCents: number, country: string, table: readonly EuVatRate[] = EU_VAT_RATES, today = new Date()): VatOnTop | null {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) return null;
  if (expired(table, today)) return null;
  const rate = rateOf(country, table);
  if (!rate) return null;
  // Integer arithmetic: price × basis points stays far inside the safe range for any price a checkout takes.
  const product = priceCents * rate.basisPoints;
  if (!Number.isSafeInteger(product)) return null;
  const vatCents = Math.floor((product + 5000) / 10000);
  return { priceCents, vatCents, totalCents: priceCents + vatCents, basisPoints: rate.basisPoints, country };
}
