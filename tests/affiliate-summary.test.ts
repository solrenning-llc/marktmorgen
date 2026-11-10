/**
 * 532 [AF1], unit 1: the program's three numbers at the top of the affiliate studio, for this month, 90 days or
 * all time, worked out from the book the page already reads (lib/affiliates.ts readBook), never read again:
 *   - affiliates active: with a sale in the period (clicks are kept as all-time totals only, so they count only
 *     for "all time", and the words say so);
 *   - sold through affiliates: what the buyers paid before tax, after refunds, of the sales themselves (a bonus, a
 *     second-tier share or a lead adds nothing sold);
 *   - earned: every commission in the period after refunds, paid or still owed;
 * an own purchase never counts; another currency is left out and counted apart; refunds not checked are said.
 * Synthetic book only.
 */
import * as summaryLib from "@/lib/affiliate-summary";
import type { Book, Line, Row } from "@/lib/affiliates";
import { done, is, part } from "./check";

type Summary = { active: number; activeBy: "sales" | "clicks or sales"; soldCents: number; earnedCents: number; sales: number; elsewhere: number; refundsChecked: boolean };
const programSummary = (summaryLib as unknown as { programSummary?: (b: Pick<Book, "rows" | "lines" | "currency" | "refundsChecked">, p: string, now: number) => Summary | null }).programSummary;

const now = Date.UTC(2026, 10, 10, 12);
const sec = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400_000;
let n = 0;
const line = (over: Partial<Line>): Line => ({
  ref: `cs_${++n}`, pi: `pi_${n}`, aff: "a1", at: sec(now - DAY), product: "p1", title: "Guide", base: 10_000, total: 12_000, currency: "usd", rate: 0.3, self: false, how: "click", refunded: 0, commission: 3_000, status: "earned", ...over,
} as Line);
const row = (id: string, clicks: number): Row => ({ affiliate: { id } as Row["affiliate"], clicks, sales: 0, earned: 0, paid: 0, owed: 0, waiting: 0, payable: 0, held: 0, flags: [], paidClicks: 0 });

async function main(): Promise<void> {
  is("the summary exists", typeof programSummary, "function");
  if (!programSummary) return done();
  const lines: Line[] = [
    line({ aff: "a1" }),
    line({ aff: "a1", at: sec(now - 20 * DAY) }), // last month, inside 90 days
    line({ aff: "a2", refunded: 6_000, commission: 1_500, status: "partly refunded" }), // half refunded: base kept 5,000
    line({ aff: "a3", refunded: 12_000, commission: 0, status: "refunded" }), // all refunded
    line({ aff: "a4", self: true, commission: 0, status: "own purchase" }),
    line({ aff: "a5", how: "bonus", base: 0, total: 0, commission: 2_000 }),
    line({ aff: "a6", how: "tier2", rate: 0.05, commission: 500 }), // a second-tier share of a1's sale
    line({ aff: "a7", how: "lead", base: 0, total: 0, commission: 400, status: "earned" }),
    line({ aff: "a8", currency: "eur" }),
    line({ aff: "a9", at: sec(now - 200 * DAY) }), // before 90 days
  ];
  const book = { rows: [row("a1", 5), row("a10", 3), row("a11", 0)], lines, currency: "usd", refundsChecked: true };

  part("This month");
  const month = programSummary(book, "month", now)!;
  is("active: affiliates with a sale that still earns, this month; never an own purchase, a bonus, a lead or a refunded sale", [month.active, month.activeBy], [2, "sales"]);
  is("sold: before tax, after refunds, sales only (a1 10,000 + a2 5,000)", month.soldCents, 15_000);
  is("earned: every commission after refunds, paid or owed (3,000 + 1,500 + 2,000 bonus + 500 tier + 400 lead)", month.earnedCents, 7_400);
  is("a sale in another currency is left out and counted apart", month.elsewhere, 1);

  part("90 days and all time");
  const ninety = programSummary(book, "days90", now)!;
  is("90 days takes the sale of 20 days ago", [ninety.active, ninety.soldCents, ninety.earnedCents], [2, 25_000, 10_400]);
  const all = programSummary(book, "all", now)!;
  is("all time: active by clicks or sales (a1, a2, a9 by sales; a10 by clicks)", [all.active, all.activeBy], [4, "clicks or sales"]);
  is("all time takes every sale", [all.soldCents, all.sales], [35_000, 4]);

  part("Totals agree with the lines and refunds are said");
  is("an unchecked book says so", programSummary({ ...book, refundsChecked: false }, "month", now)!.refundsChecked, false);
  is("a period that is not one gives nothing", programSummary(book, "week", now), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
