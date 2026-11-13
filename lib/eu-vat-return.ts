/**
 * EU VAT under art. 9a, part 2 of the build, unit 8a: the quarterly non-Union OSS return's figures from the art. 63c
 * records (lib/eu-vat-record.ts; docs/eu-vat-article-9a.md, "The code that would be needed", point 6). Pure; it files
 * nothing and reads nothing.
 *
 *   lines        the quarter's sales per Member State and VAT rate: taxable amount and VAT, with the refunds dated in
 *                the same quarter netted in;
 *   corrections  refunds dated in this quarter on sales of an earlier quarter, as that quarter's VAT correction per
 *                Member State (the non-Union scheme corrects an earlier period in a later return);
 * Refunds dated after the quarter are left for the quarter they fall in. Amounts are in euro cents at the rate the
 * caller gives for each currency (`eurPerUnit`, euros per unit of that currency): the Directive ties the return's rate
 * to one published for the period, read when the return is built, not here. A currency with no valid rate, a quarter
 * that is not one, or a record that is not whole leaves the whole return unknown (null): never a guess, never a line
 * left out.
 */
import type { EuVatRecord } from "@/lib/eu-vat-record";

export type OssLine = { memberState: string; basisPoints: number; taxableEuroCents: number; vatEuroCents: number };
export type OssCorrection = { period: string; memberState: string; vatEuroCents: number };
export type OssReturn = { period: string; lines: OssLine[]; corrections: OssCorrection[] };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
function quarterOf(day: unknown): string | null {
  if (typeof day !== "string") return null;
  const m = DAY.exec(day);
  const date = new Date(`${day}T00:00:00Z`);
  if (!m || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return `${m[1]}-Q${Math.floor((Number(m[2]) - 1) / 3) + 1}`;
}
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

export function ossReturn(records: readonly EuVatRecord[], input: { year: number; quarter: number; eurPerUnit: Record<string, number> }): OssReturn | null {
  if (!whole(input.year) || input.year < 2000 || ![1, 2, 3, 4].includes(input.quarter)) return null;
  const period = `${input.year}-Q${input.quarter}`;
  const toEuro = (cents: number, currency: string): number | null => {
    const rate = Object.hasOwn(input.eurPerUnit, currency) ? input.eurPerUnit[currency] : undefined;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
    const euro = Math.round(cents * rate);
    return Number.isSafeInteger(euro) ? euro : null;
  };
  // Summed in each record's own currency first, converted once per sum.
  const lineSums = new Map<string, { memberState: string; basisPoints: number; currency: string; taxable: number; vat: number }>();
  const correctionSums = new Map<string, { period: string; memberState: string; currency: string; vat: number }>();
  for (const record of records) {
    if (!record || typeof record !== "object" || !Array.isArray(record.adjustments)) return null;
    const saleQuarter = quarterOf(record.date);
    if (!saleQuarter || !whole(record.taxableCents) || !whole(record.vatCents) || !whole(record.rateBasisPoints)) return null;
    if (typeof record.memberState !== "string" || typeof record.currency !== "string") return null;
    const currency = record.currency.toUpperCase();
    let taxable = saleQuarter === period ? record.taxableCents : 0;
    let vat = saleQuarter === period ? record.vatCents : 0;
    for (const adjustment of record.adjustments) {
      const when = quarterOf(adjustment?.date);
      if (!when || !whole(adjustment.taxableCents) || !whole(adjustment.vatCents)) return null;
      if (when !== period) continue;
      if (saleQuarter === period) {
        taxable += adjustment.taxableCents;
        vat += adjustment.vatCents;
      } else {
        const key = `${saleQuarter}|${record.memberState}|${currency}`;
        const sum = correctionSums.get(key) ?? { period: saleQuarter, memberState: record.memberState, currency, vat: 0 };
        sum.vat += adjustment.vatCents;
        correctionSums.set(key, sum);
      }
    }
    if (saleQuarter === period) {
      const key = `${record.memberState}|${record.rateBasisPoints}|${currency}`;
      const sum = lineSums.get(key) ?? { memberState: record.memberState, basisPoints: record.rateBasisPoints, currency, taxable: 0, vat: 0 };
      sum.taxable += taxable;
      sum.vat += vat;
      lineSums.set(key, sum);
    }
  }
  const lines = new Map<string, OssLine>();
  for (const sum of lineSums.values()) {
    const taxableEuro = toEuro(sum.taxable, sum.currency);
    const vatEuro = toEuro(sum.vat, sum.currency);
    if (taxableEuro === null || vatEuro === null) return null;
    const key = `${sum.memberState}|${sum.basisPoints}`;
    const line = lines.get(key) ?? { memberState: sum.memberState, basisPoints: sum.basisPoints, taxableEuroCents: 0, vatEuroCents: 0 };
    line.taxableEuroCents += taxableEuro;
    line.vatEuroCents += vatEuro;
    lines.set(key, line);
  }
  const corrections = new Map<string, OssCorrection>();
  for (const sum of correctionSums.values()) {
    const vatEuro = toEuro(sum.vat, sum.currency);
    if (vatEuro === null) return null;
    const key = `${sum.period}|${sum.memberState}`;
    const correction = corrections.get(key) ?? { period: sum.period, memberState: sum.memberState, vatEuroCents: 0 };
    correction.vatEuroCents += vatEuro;
    corrections.set(key, correction);
  }
  const byState = (a: { memberState: string }, b: { memberState: string }) => a.memberState.localeCompare(b.memberState);
  return {
    period,
    lines: [...lines.values()].sort((a, b) => byState(a, b) || a.basisPoints - b.basisPoints),
    corrections: [...corrections.values()].sort((a, b) => a.period.localeCompare(b.period) || byState(a, b)),
  };
}
