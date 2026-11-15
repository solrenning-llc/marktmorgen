/**
 * EU VAT under art. 9a, unit 8a, rebuilt as unit 2 (IVA, 14/11/2026): the quarterly non-Union OSS return from the
 * art. 63c records (lib/eu-vat-record.ts), in the shape of Annex III of Implementing Regulation (EU) 2020/194, and the
 * file the owner keeps or uploads. Pure: it files nothing, reads nothing and stores nothing.
 *
 * Sources, read on 14/11/2026:
 *   - "Guide to the VAT One Stop Shop", revised July 2026 (vat-one-stop-shop.ec.europa.eu, Guides; SHA-256 of the PDF
 *     3a0a000a…): a return "for each tax period, whether or not services or goods were supplied", a "nil return"
 *     with zero totals otherwise; submitted "by the end of the month following the tax period"; currency the euro,
 *     converted at "the exchange rate as published by the European Central Bank on the last date of the tax period"
 *     (lib/ecb-rates.ts, with art. 366(2)'s next day of publication); part 2 "cannot be negative", part 3
 *     (corrections) can; "A negative amount for one Member State of consumption is never set off against VAT due for
 *     other Member States", so part 5 sums only the positive balances; corrections "within three years of the date on
 *     which the initial return had to be submitted", after which "the taxable person will be required to contact the
 *     Member State of consumption directly"; a credit note is "a correction to the One Stop Shop VAT return for the
 *     period in which the supply was declared"; records kept "for 10 years from the end of the year in which the
 *     transaction was made".
 *   - Annex III of Regulation 2020/194 (legislation.gov.uk/eur/2020/194/annex/III): boxes 1 (VAT identification
 *     number), 2 (tax period, Qn.yyyy), 3 (currency), 4.1 / 5.1 / 7.1 / 8.1 (Member State of consumption, standard rate,
 *     taxable amount and VAT at it), 11.1 (total VAT payable), 22.1 / 23.1 / 24.1 (corrections: period, Member State,
 *     VAT), 25.1 (balance per Member State, may be negative), 26 (total; negative balances not taken into account).
 *
 * Only standard rates are ever charged (lib/eu-vat-amount.ts), so every line is a standard-rate line (boxes 5 to 8);
 * when a reduced rate is modelled its records must carry the kind. A correction is converted at the ECB rate of the
 * end of the period it corrects, so it reverses exactly what that return declared (the guide does not say which rate;
 * NOT CHECKED, the reading that never shrinks the declared figure by a later rate). Anything that does not read (a
 * record, a quarter, a currency without its rate, a part-2 line below zero, a return asked before its quarter ended)
 * leaves the whole return unknown (null): never a guess, never a line left out.
 */
import type { EuVatRecord } from "@/lib/eu-vat-record";
import { type EcbRates, periodEndRate } from "@/lib/ecb-rates";
import { toEuroCents } from "@/lib/eu-vat-invoice";

/** Years after the original return's deadline during which it is corrected through the OSS (OSS guide, Part 2). */
export const OSS_CORRECTION_YEARS = 3;
/** Years the records are kept, from the end of the year of each transaction (Directive art. 369(2); OSS guide). */
export const OSS_KEEP_YEARS = 10;

export type OssLine = { memberState: string; rate: "standard"; basisPoints: number; taxableEuroCents: number; vatEuroCents: number };
export type OssCorrection = { period: string; memberState: string; vatEuroCents: number };
export type OssBalance = { memberState: string; vatEuroCents: number };
export type OssRateUsed = { currency: string; period: string; perEuro: string; day: string };
export type OssReturn = {
  /** "2027-Q1" here; "Q1.2027" as Annex III writes it. */
  period: string;
  annexPeriod: string;
  firstDay: string;
  lastDay: string;
  /** The last day to submit and pay (OSS guide: "There is no change to the deadline [...] if this date falls on the weekend or on a public holiday"). */
  deadline: string;
  currency: "EUR";
  nil: boolean;
  lines: OssLine[];
  corrections: OssCorrection[];
  /** Corrections older than the three years: not in this return; the owner settles them with that Member State. */
  outsideOss: OssCorrection[];
  balances: OssBalance[];
  totalEuroCents: number;
  rates: OssRateUsed[];
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const realDay = (day: unknown): day is string => {
  if (typeof day !== "string" || !DAY.test(day)) return false;
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
};
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

type Quarter = { year: number; quarter: number };
function quarterOf(day: unknown): Quarter | null {
  if (!realDay(day)) return null;
  return { year: Number(day.slice(0, 4)), quarter: Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1 };
}
const label = (q: Quarter) => `${q.year}-Q${q.quarter}`;
const firstDayOf = (q: Quarter) => iso(Date.UTC(q.year, (q.quarter - 1) * 3, 1));
const lastDayOf = (q: Quarter) => iso(Date.UTC(q.year, q.quarter * 3, 0));
/** The end of the month following the quarter. */
const deadlineOf = (q: Quarter) => iso(Date.UTC(q.year, q.quarter * 3 + 1, 0));
const plusYears = (day: string, years: number) => {
  const [y, m, d] = day.split("-").map(Number);
  // 29 February plus years lands on 28 February when that year has none: never a later day.
  const target = new Date(Date.UTC(y + years, m - 1, d));
  return target.getUTCMonth() === m - 1 ? iso(target.getTime()) : iso(Date.UTC(y + years, m, 0));
};

/** The last day a record of a transaction made on `day` must be kept: 31 December of the tenth year after its year. */
export function ossKeepUntil(day: string): string | null {
  return realDay(day) ? `${Number(day.slice(0, 4)) + OSS_KEEP_YEARS}-12-31` : null;
}

/** The deadline of the return of the quarter that holds `day`, and the last day it can still be corrected through the OSS. */
export function ossDeadlines(day: string): { deadline: string; correctableUntil: string } | null {
  const q = quarterOf(day);
  if (!q) return null;
  const deadline = deadlineOf(q);
  return { deadline, correctableUntil: plusYears(deadline, OSS_CORRECTION_YEARS) };
}

/**
 * The return of `year`/`quarter`, built on `filedOn` (YYYY-MM-DD, after the quarter's last day), with the ECB rates
 * the records' currencies need at the end of this quarter and of each quarter corrected.
 */
export function ossReturn(records: readonly EuVatRecord[], input: { year: number; quarter: number; rates: EcbRates; filedOn: string }): OssReturn | null {
  if (!whole(input.year) || input.year < 2000 || input.year > 9000 || ![1, 2, 3, 4].includes(input.quarter)) return null;
  if (!Array.isArray(records) || !input.rates || !realDay(input.filedOn)) return null;
  const q: Quarter = { year: input.year, quarter: input.quarter };
  const period = label(q);
  const lastDay = lastDayOf(q);
  // "The taxable person may not submit the One Stop Shop VAT return before the end of the return period" (OSS guide).
  if (input.filedOn <= lastDay) return null;

  const used = new Map<string, OssRateUsed>();
  const rateFor = (currency: string, of: Quarter): string | null => {
    if (currency === "EUR") return "1";
    const key = `${currency}|${label(of)}`;
    const known = used.get(key);
    if (known) return known.perEuro;
    const found = periodEndRate(input.rates, currency, lastDayOf(of));
    if (!found) return null;
    used.set(key, { currency, period: label(of), perEuro: found.perEuro, day: found.day });
    return found.perEuro;
  };

  // Summed in each record's own currency first, converted once per sum.
  const lineSums = new Map<string, { memberState: string; basisPoints: number; currency: string; taxable: number; vat: number }>();
  const correctionSums = new Map<string, { of: Quarter; memberState: string; currency: string; vat: number }>();
  for (const record of records) {
    if (!record || typeof record !== "object" || !Array.isArray(record.adjustments)) return null;
    const sold = quarterOf(record.date);
    if (!sold || !whole(record.taxableCents) || !whole(record.vatCents) || !whole(record.rateBasisPoints)) return null;
    if (typeof record.memberState !== "string" || !/^[A-Z]{2}$/.test(record.memberState) || typeof record.currency !== "string") return null;
    const currency = record.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return null;
    const soldHere = label(sold) === period;
    let taxable = soldHere ? record.taxableCents : 0;
    let vat = soldHere ? record.vatCents : 0;
    for (const adjustment of record.adjustments) {
      const when = quarterOf(adjustment?.date);
      if (!when || !whole(adjustment.taxableCents) || !whole(adjustment.vatCents)) return null;
      if (label(when) !== period) continue;
      if (soldHere) {
        taxable += adjustment.taxableCents;
        vat += adjustment.vatCents;
      } else {
        const key = `${label(sold)}|${record.memberState}|${currency}`;
        const sum = correctionSums.get(key) ?? { of: sold, memberState: record.memberState, currency, vat: 0 };
        sum.vat += adjustment.vatCents;
        correctionSums.set(key, sum);
      }
    }
    if (soldHere) {
      const key = `${record.memberState}|${record.rateBasisPoints}|${currency}`;
      const sum = lineSums.get(key) ?? { memberState: record.memberState, basisPoints: record.rateBasisPoints, currency, taxable: 0, vat: 0 };
      sum.taxable += taxable;
      sum.vat += vat;
      lineSums.set(key, sum);
    }
  }

  const lines = new Map<string, OssLine>();
  for (const sum of lineSums.values()) {
    if (sum.taxable < 0 || sum.vat < 0) return null; // part 2 cannot be negative
    const perEuro = rateFor(sum.currency, q);
    if (perEuro === null) return null;
    const taxable = toEuroCents(sum.taxable, perEuro);
    const vat = toEuroCents(sum.vat, perEuro);
    if (taxable === null || vat === null) return null;
    const key = `${sum.memberState}|${sum.basisPoints}`;
    const line = lines.get(key) ?? { memberState: sum.memberState, rate: "standard" as const, basisPoints: sum.basisPoints, taxableEuroCents: 0, vatEuroCents: 0 };
    line.taxableEuroCents += taxable;
    line.vatEuroCents += vat;
    lines.set(key, line);
  }
  // A sale refunded in full within its own quarter leaves a line of nothing: not declared.
  for (const [key, line] of lines) if (line.taxableEuroCents === 0 && line.vatEuroCents === 0) lines.delete(key);

  const inside = new Map<string, OssCorrection>();
  const outside = new Map<string, OssCorrection>();
  for (const sum of correctionSums.values()) {
    if (sum.vat === 0) continue;
    const perEuro = rateFor(sum.currency, sum.of);
    if (perEuro === null) return null;
    const magnitude = toEuroCents(Math.abs(sum.vat), perEuro);
    if (magnitude === null) return null;
    const vat = sum.vat < 0 ? -magnitude : magnitude;
    const correctable = plusYears(deadlineOf(sum.of), OSS_CORRECTION_YEARS);
    const into = input.filedOn <= correctable ? inside : outside;
    const key = `${label(sum.of)}|${sum.memberState}`;
    const correction = into.get(key) ?? { period: label(sum.of), memberState: sum.memberState, vatEuroCents: 0 };
    correction.vatEuroCents += vat;
    into.set(key, correction);
  }

  const byState = (a: { memberState: string }, b: { memberState: string }) => a.memberState.localeCompare(b.memberState);
  const sortedLines = [...lines.values()].sort((a, b) => byState(a, b) || a.basisPoints - b.basisPoints);
  const sortedCorrections = [...inside.values()].filter((c) => c.vatEuroCents !== 0).sort((a, b) => a.period.localeCompare(b.period) || byState(a, b));
  const balances = new Map<string, number>();
  for (const line of sortedLines) balances.set(line.memberState, (balances.get(line.memberState) ?? 0) + line.vatEuroCents);
  for (const correction of sortedCorrections) balances.set(correction.memberState, (balances.get(correction.memberState) ?? 0) + correction.vatEuroCents);
  const sortedBalances = [...balances].map(([memberState, vatEuroCents]) => ({ memberState, vatEuroCents })).sort(byState);
  const totalEuroCents = sortedBalances.reduce((n, b) => n + Math.max(0, b.vatEuroCents), 0);
  return {
    period,
    annexPeriod: `Q${q.quarter}.${q.year}`,
    firstDay: firstDayOf(q),
    lastDay,
    deadline: deadlineOf(q),
    currency: "EUR",
    nil: sortedLines.length === 0 && sortedCorrections.length === 0,
    lines: sortedLines,
    corrections: sortedCorrections,
    outsideOss: [...outside.values()].filter((c) => c.vatEuroCents !== 0).sort((a, b) => a.period.localeCompare(b.period) || byState(a, b)),
    balances: sortedBalances,
    totalEuroCents,
    rates: [...used.values()].sort((a, b) => a.period.localeCompare(b.period) || a.currency.localeCompare(b.currency)),
  };
}

const euro = (cents: number) => `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const percent = (basisPoints: number) => `${Math.floor(basisPoints / 100)}.${String(basisPoints % 100).padStart(2, "0")}`;

/**
 * The return as a CSV the owner keeps, or copies into the identification Member State's portal, box by box (Annex
 * III numbering), in euro with a point and two decimals. Null until the OSS number EUxxxyyyyyz is configured.
 */
export function ossReturnCsv(ret: OssReturn, vatNumber: string): string | null {
  if (!ret || typeof vatNumber !== "string" || !/^EU\d{9}$/.test(vatNumber)) return null;
  const rows: string[][] = [["part", "box", "item", "member_state", "period", "rate_percent", "amount_eur"]];
  rows.push(["1", "1", "VAT identification number", "", "", "", vatNumber]);
  rows.push(["1", "2", "Tax period", "", ret.annexPeriod, "", ""]);
  rows.push(["1", "3", "Currency", "", "", "", ret.currency]);
  ret.lines.forEach((line, i) => {
    const n = `${i + 1}`;
    rows.push(["2", `4.${n}`, "Member State of consumption", line.memberState, ret.annexPeriod, "", ""]);
    rows.push(["2", `7.${n}`, "Taxable amount at standard rate", line.memberState, ret.annexPeriod, percent(line.basisPoints), euro(line.taxableEuroCents)]);
    rows.push(["2", `8.${n}`, "VAT amount at standard rate", line.memberState, ret.annexPeriod, percent(line.basisPoints), euro(line.vatEuroCents)]);
  });
  ret.corrections.forEach((c, i) => {
    const [year, quarter] = c.period.split("-Q");
    rows.push(["3", `24.${i + 1}`, "VAT correction", c.memberState, `Q${quarter}.${year}`, "", euro(c.vatEuroCents)]);
  });
  ret.balances.forEach((b, i) => rows.push(["4", `25.${i + 1}`, "Balance of VAT due", b.memberState, ret.annexPeriod, "", euro(b.vatEuroCents)]));
  rows.push(["5", "26", ret.nil ? "Total VAT due (nil return)" : "Total VAT due", "", ret.annexPeriod, "", euro(ret.totalEuroCents)]);
  for (const c of ret.outsideOss) {
    const [year, quarter] = c.period.split("-Q");
    rows.push(["outside", "", "Correction older than three years: settle with the Member State of consumption", c.memberState, `Q${quarter}.${year}`, "", euro(c.vatEuroCents)]);
  }
  for (const r of ret.rates) rows.push(["rates", "", `ECB rate ${r.currency} per EUR on ${r.day}`, "", r.period, "", r.perEuro]);
  return rows.map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\n") + "\n";
}
