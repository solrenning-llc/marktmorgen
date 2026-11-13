/**
 * EU VAT under art. 9a, part 2 of the build, unit 3: the VAT added on top of the buyer's price (docs/eu-vat-article-9a.md).
 * Pure: imports only the list of Member States.
 *
 * The owner's design: the VAT is added on top of the buyer's price (or taken from the creator's payout), never from
 * Marktmorgen's commission. So the price and Marktmorgen's share never change here; the VAT is its own amount.
 *
 * Rates. A rate is used only from EU_VAT_RATES, each with the official source it was read from and the day it was read.
 * The table starts EMPTY on purpose: no rate is typed from memory. The rates and their sources come with part 1 (the
 * dated legal re-check), and a country with no valid record is no sale (vatOnTop answers null), never a default rate.
 * Only the standard rate is modelled; a reduced rate for a kind of product (Directive annex III, e.g. e-books) needs its
 * own sourced record and a classification that says the product qualifies, and is not built.
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
};

/** Empty until part 1 brings each rate with its official source and the day it was read. */
export const EU_VAT_RATES: readonly EuVatRate[] = [];

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
export function euVatRateProblems(table: readonly EuVatRate[] = EU_VAT_RATES): string[] {
  const out: string[] = [];
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
export function vatOnTop(priceCents: number, country: string, table: readonly EuVatRate[] = EU_VAT_RATES): VatOnTop | null {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) return null;
  const rate = rateOf(country, table);
  if (!rate) return null;
  // Integer arithmetic: price × basis points stays far inside the safe range for any price a checkout takes.
  const product = priceCents * rate.basisPoints;
  if (!Number.isSafeInteger(product)) return null;
  const vatCents = Math.floor((product + 5000) / 10000);
  return { priceCents, vatCents, totalCents: priceCents + vatCents, basisPoints: rate.basisPoints, country };
}
