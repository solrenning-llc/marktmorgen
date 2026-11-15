/**
 * What the studio shows for a funnel's split test step (526 [FN2], unit 3):
 * each version's figures side by side and the verdict of the one winner rule
 * there is, abDecision (lib/ab-decision.ts, 377 [TB3]). Pure and browser-safe.
 *
 * The figures are the funnel's own counts, kept per version
 * (lib/page-funnel-store.ts, readSplitCountsStrict): the people who opened a
 * version's page and those who signed up or paid there. The rule decides by
 * the money each version kept after refunds and disputes, which the funnel
 * does not count per version yet, so it is given only what is real and
 * refuses; its own words are shown, and no money is made up to let it decide.
 */
import { type AbVerdict, type AbVersion, abDecision } from "@/lib/ab-decision";
import { splitVersion } from "@/lib/funnel-split-rules";
import type { SplitStep } from "@/lib/page-funnel";

/** One version's row: its label, its page, and its counts (null when they could not be read, never 0). */
export type SplitRow = { version: string; label: string; title: string; seen: number | null; done: number | null };

export type SplitView = {
  rows: SplitRow[];
  result: AbVerdict["result"];
  /** The version the rule names, only when it names one. */
  winner: string | null;
  /** The rule's own words. */
  words: string;
  /** What the rule still needs that the funnel does not count; empty when nothing is missing. */
  note: string;
};

/** Said beside the verdict while the funnel counts no money per version. */
export const SPLIT_MONEY_NOTE =
  "The money each version brought in is not counted per version yet. The winner rule compares the money each version kept after refunds and disputes, so it cannot name a winner from these counts alone.";

/** A count as the studio writes it: the number, or that it could not be read. */
export const splitCell = (value: number | null): string => (value === null ? "Count unavailable" : value.toLocaleString("en-US"));

/**
 * The view of one split step. `titles` and `kinds` are its destinations' as
 * the store stands, in its order; `counts` its counts per version, or null
 * when they could not be read; `since` when its counts began (seconds), `now`
 * when it is read (ms, the moment of the call when not given).
 */
export function splitView(input: {
  step: SplitStep;
  titles: readonly string[];
  kinds: readonly { product: boolean; free: boolean }[];
  counts: readonly { version: string; seen: number; done: number }[] | null;
  since: number;
  now?: number;
}): SplitView {
  const { step, titles, kinds, counts, since, now = Date.now() } = input;
  const rows: SplitRow[] = step.options.flatMap((_, place) => {
    const version = splitVersion(place);
    if (!version) return [];
    const count = counts?.find((one) => one.version === version) ?? null;
    return [{ version, label: `Version ${version.toUpperCase()}`, title: titles[place] ?? "A page no longer available", seen: count?.seen ?? null, done: count?.done ?? null }];
  });
  // Only what is real: the people who opened each version, and, for a paid
  // product, its sales. Money paid, refunded and disputed is not counted per
  // version, so it is left out and the rule refuses rather than decide.
  const versions = rows.map((row, place) => ({
    id: row.version,
    ...(row.seen === null ? {} : { visitors: row.seen }),
    ...(row.done !== null && kinds[place]?.product && !kinds[place]?.free ? { paidOrders: row.done } : {}),
  })) as unknown as AbVersion[];
  const verdict = abDecision({ versions, startedAt: since * 1000, now, shares: step.options.map((option) => option.share / 100) });
  return {
    rows,
    result: verdict.result,
    winner: verdict.result === "winner" ? verdict.winner : null,
    words: verdict.words,
    note: SPLIT_MONEY_NOTE,
  };
}
