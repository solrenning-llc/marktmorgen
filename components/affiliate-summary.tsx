"use client";

import { useId, useState } from "react";
import { formatMoney } from "@/lib/money";
import type { ProgramSummary, SummaryPeriod } from "@/lib/affiliate-summary";

/** The periods the creator can choose, in the order shown. */
export const PERIOD_WORDS: Readonly<Record<SummaryPeriod, string>> = {
  month: "This month",
  days90: "Last 90 days",
  all: "All time",
};

/** What "active" means for the period chosen, said beside the number. */
export function activeWords(summary: Pick<ProgramSummary, "activeBy">): string {
  return summary.activeBy === "sales"
    ? "With at least one sale in this period. Clicks are kept as all-time totals, so they count only under All time."
    : "With at least one click or sale since your program started.";
}

/**
 * The affiliate program's three numbers (532 [AF1], unit 1), for the period the creator picks, worked out on the
 * server from the book the page already read (lib/affiliate-summary.ts). Plain numbers with their words, never a
 * chart; the choice is a set of radio buttons; the numbers are a description list.
 */
export function AffiliateSummary({ summaries, currency }: { summaries: Readonly<Record<SummaryPeriod, ProgramSummary>>; currency: string }) {
  const id = useId();
  const [period, setPeriod] = useState<SummaryPeriod>("month");
  const summary = summaries[period];
  const money = (cents: number) => formatMoney(cents, currency);
  return (
    <section aria-labelledby={`${id}-title`} className="mt-8 rounded-2xl border border-line bg-paper p-5">
      <h2 id={`${id}-title`} className="t-h3">Your program at a glance</h2>
      <fieldset className="mt-3">
        <legend className="text-sm font-semibold text-ink">Period</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {(Object.keys(PERIOD_WORDS) as SummaryPeriod[]).map((value) => (
            <label key={value} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-2xl border px-4 py-2 text-sm ${period === value ? "border-[var(--violet)]" : "border-line"}`}>
              <input type="radio" name={`${id}-period`} value={value} checked={period === value} onChange={() => setPeriod(value)} className="h-4 w-4 shrink-0 accent-[var(--violet)]" />
              <span className="font-semibold text-ink">{PERIOD_WORDS[value]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div aria-live="polite">
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-ink-soft">Affiliates active</dt>
            <dd className="mt-1 text-2xl font-semibold text-ink">{summary.active}</dd>
            <dd className="mt-1 text-xs text-ink-soft">{activeWords(summary)}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-soft">Sold through affiliates</dt>
            <dd className="mt-1 text-2xl font-semibold text-ink">{money(summary.soldCents)}</dd>
            <dd className="mt-1 text-xs text-ink-soft">{`${summary.sales} ${summary.sales === 1 ? "sale" : "sales"}, what buyers paid before tax, after refunds.`}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-soft">Earned by affiliates</dt>
            <dd className="mt-1 text-2xl font-semibold text-ink">{money(summary.earnedCents)}</dd>
            <dd className="mt-1 text-xs text-ink-soft">Paid already and still owed, after refunds, bonuses included.</dd>
          </div>
        </dl>
        {summary.elsewhere > 0 ? (
          <p className="mt-3 text-sm text-ink-soft">{`${summary.elsewhere} ${summary.elsewhere === 1 ? "sale or payment" : "sales or payments"} in another currency ${summary.elsewhere === 1 ? "is" : "are"} left out of these totals and listed below with ${summary.elsewhere === 1 ? "its" : "their"} own currency.`}</p>
        ) : null}
        {summary.refundsChecked ? null : (
          <p className="notice notice-warn mt-3 text-sm" role="status">Refunds could not all be checked with Stripe just now, so these totals may still include a refunded sale. Reload the page in a minute.</p>
        )}
      </div>
    </section>
  );
}
