/**
 * The affiliate program's three numbers at the top of the studio's affiliate page (532 [AF1], unit 1), for this
 * month, the last 90 days or all time. Worked out from the book the page already reads (lib/affiliates.ts readBook),
 * so it reads nothing of its own and costs nothing beyond that reading. Pure.
 *
 *   - Affiliates active: those with a sale that still earns in the period. Clicks are kept only as all-time totals
 *     (recordClick, one count per affiliate), so they count toward "active" only for all time, and the page says so.
 *   - Sold through affiliates: what the buyers paid before tax, after refunds, for the sales themselves. A bonus, a
 *     second-tier share (which repeats a sale already counted) or a lead adds nothing sold.
 *   - Earned: every commission in the period after refunds, whether paid already or still owed.
 *
 * An own purchase never counts. A sale in another currency than the store's is left out and counted apart, as the
 * book already does. Refunds not checked with Stripe are said (refundsChecked), never hidden.
 */
import type { Book, Line } from "@/lib/affiliates";

export const SUMMARY_PERIODS = ["month", "days90", "all"] as const;
export type SummaryPeriod = (typeof SUMMARY_PERIODS)[number];

export type ProgramSummary = {
  period: SummaryPeriod;
  /** Affiliates with a sale that still earns in the period; for all time, those with a click or such a sale. */
  active: number;
  activeBy: "sales" | "clicks or sales";
  /** Before tax, after refunds, of the sales themselves, in the store's currency's smallest unit. */
  soldCents: number;
  /** Every commission after refunds, paid or owed, in the store's currency's smallest unit. */
  earnedCents: number;
  /** Sales in the period that still earn. */
  sales: number;
  /** Lines in the period in another currency, left out of the totals. */
  elsewhere: number;
  refundsChecked: boolean;
};

const DAY_MS = 86_400_000;
/** Lines that are a sale of their own; the others (bonus, second tier, lead) ride on a sale or are not one. */
const SALE_HOW = new Set(["click", "code", "buyer", "partner", "contact", "recurring", undefined]);

/** When the period starts, in seconds as a line's `at` is kept; null for a period that is not one. */
export function periodStart(period: string, now: number): number | null {
  if (period === "all") return 0;
  if (period === "days90") return Math.floor((now - 90 * DAY_MS) / 1000);
  if (period === "month") {
    const at = new Date(now);
    return Math.floor(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1) / 1000);
  }
  return null;
}

/** What a line's buyers paid before tax and kept after refunds: the base its commission is worked out from. */
function keptBase(line: Line): number {
  if (line.total <= 0) return 0;
  const back = Math.min(Math.max(0, line.refunded), line.total);
  return Math.round((line.base * (line.total - back)) / line.total);
}

/** The program's three numbers for `period`, from `book`; null for a period that is not one. */
export function programSummary(book: Pick<Book, "rows" | "lines" | "currency" | "refundsChecked">, period: string, now = Date.now()): ProgramSummary | null {
  const since = periodStart(period, now);
  if (since === null) return null;
  const currency = book.currency.toLowerCase();
  let soldCents = 0;
  let earnedCents = 0;
  let sales = 0;
  let elsewhere = 0;
  const active = new Set<string>();
  for (const line of book.lines) {
    if (line.at < since || line.self) continue;
    if ((line.currency || "usd").toLowerCase() !== currency) {
      elsewhere += 1;
      continue;
    }
    earnedCents += line.commission;
    if (!SALE_HOW.has(line.how)) continue;
    const kept = keptBase(line);
    soldCents += kept;
    if (line.status === "earned" || line.status === "partly refunded") {
      sales += 1;
      active.add(line.aff);
    }
  }
  const allTime = period === "all";
  if (allTime) for (const row of book.rows) if (row.clicks > 0) active.add(row.affiliate.id);
  return { period: period as SummaryPeriod, active: active.size, activeBy: allTime ? "clicks or sales" : "sales", soldCents, earnedCents, sales, elsewhere, refundsChecked: book.refundsChecked };
}
