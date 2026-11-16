/**
 * The winner rule for a test of two to four versions (377 [TB3], unit 1;
 * docs/tb3-ab-design.md). Pure: it reads nothing, writes nothing and never
 * switches what visitors see. It takes each version's figures and says
 * either "winner X" or "no clear winner yet", with the reason and the
 * numbers to show.
 *
 * It extends the headline test's rule (lib/headline-test-rules.ts) without
 * changing it:
 *
 *   - Money is net of refunds and of disputes that take the money (the
 *     states in DISPUTE_TAKES, lib/retained-revenue.ts: on Stripe a dispute
 *     is not a refund). A version wins by the money it kept per visitor:
 *     paid minus refunded minus disputed. Opened checkouts, clicks and opens
 *     never decide.
 *   - The same minimums for each version: MIN_VIEWS visitors and MIN_SALES
 *     sales that were neither refunded nor disputed at all (a sale with a
 *     partial refund keeps its net money but does not count toward the
 *     minimum).
 *   - The same refund wait: no winner before the test has run REFUND_DAYS.
 *   - The same line, valid however often the result is read: the asymptotic
 *     confidence sequence of the headline test (boundary), worked out for
 *     the two versions of each comparison. With more than two versions the
 *     5% chance of a false winner is split evenly over every pair
 *     (Bonferroni): 1 pair for two versions (exactly today's line), 3 for
 *     three, 6 for four. If every pair's line holds, a version declared ahead
 *     of all the others really is, so the whole test keeps at most a 5%
 *     chance of a false winner.
 *   - The leader must clear the line against every other version. An exact
 *     tie at the top, or a lead still inside the line, is "no clear winner
 *     yet", with the versions named.
 *   - The split is checked: when visitors are spread further from the
 *     expected shares than chance allows (chi-square, p < 0.001), something
 *     is counting wrong and nothing is decided.
 *   - Money in different currencies is never added or compared.
 *
 * Every figure must be an exact, non-negative whole number that adds up;
 * anything else is refused, never read as zero.
 */
import { FALSE_WINNER, MIN_SALES, MIN_VIEWS, REFUND_DAYS, TUNED_VIEWS } from "@/lib/headline-test-rules";
import { formatMoney } from "@/lib/money";

export const AB_MAX_VERSIONS = 4;
export const AB_MIN_VERSIONS = 2;
/** The version names, in order: a test of k versions uses k of them. */
export const AB_VERSION_IDS = ["a", "b", "c", "d"] as const;
const DAY = 86_400_000;
/** The chi-square line at p < 0.001, by degrees of freedom (versions − 1). */
const SPLIT_CHI2: Record<number, number> = { 1: 10.828, 2: 13.816, 3: 16.266 };

export type AbVersion = {
  id: string;
  /** Visitors who were shown this version and counted. */
  visitors: number;
  /** Orders paid, before refunds and disputes. */
  paidOrders: number;
  /** Money paid, before refunds and disputes, in the currency's smallest unit. */
  paidCents: number;
  /** Orders with any refund (full or partial) and no dispute counted in disputedOrders. */
  refundedOrders: number;
  /** Money refunded on those orders, in the smallest unit. */
  refundedCents: number;
  /**
   * Orders with a dispute that takes the money (DISPUTE_TAKES in
   * lib/retained-revenue.ts). Such an order counts here, not in
   * refundedOrders. Required: a store whose disputes could not be read has no
   * figures to give, never 0.
   */
  disputedOrders: number;
  /** Money those orders did not keep (the disputed amount and any refund on them), in the smallest unit. */
  disputedCents: number;
  /** The sum, over every paid order, of the square of what it kept after refunds and disputes. */
  netSquares: number;
  /** ISO currency code of every figure above, lower case. */
  currency: string;
};

export type AbInput = {
  versions: AbVersion[];
  /** When the test began (ms). */
  startedAt: number;
  /** When it is read (ms). */
  now: number;
  /** The share of visitors each version is meant to get, in the same order; equal when absent. */
  shares?: number[];
};

export type AbFigure = {
  id: string;
  label: string;
  visitors: number;
  paidOrders: number;
  refundedOrders: number;
  disputedOrders: number;
  /** Orders neither refunded nor disputed. */
  keptOrders: number;
  paidCents: number;
  refundedCents: number;
  disputedCents: number;
  netCents: number;
  /** Money kept after refunds and disputes per 100 visitors, rounded to the smallest unit. */
  netPer100Cents: number;
  currency: string;
};

export type AbComparison = { against: string; z: number; line: number };

export type AbReason =
  | "clear_lead"
  | "invalid"
  | "mixed_currencies"
  | "too_few"
  | "split"
  | "refund_window"
  | "tie"
  | "too_close";

export type AbVerdict = {
  result: "winner" | "no_clear_winner_yet";
  winner: string | null;
  reason: AbReason;
  /** One line per version, in the order given; null when the figures cannot be shown. */
  figures: AbFigure[] | null;
  /** The leader against each other version, when compared. */
  comparisons?: AbComparison[];
  /** What each version still needs before a winner can be called (too_few). */
  short?: { id: string; visitors: number; sales: number }[];
  /** Versions tied at the top (tie). */
  tied?: string[];
  /** Versions the leader is still too close to (too_close). */
  close?: string[];
  /** Days until refunds have had time to come in (refund_window). */
  daysLeft?: number;
  /** What to show, in plain American English. */
  words: string;
};

/** The chance of a false winner each pair is allowed: 5% split over every pair of versions. */
export function falseWinnerShare(versions: number): number {
  const pairs = (versions * (versions - 1)) / 2;
  return FALSE_WINNER / pairs;
}

/**
 * The z a lead must reach between two versions seen `views` times together,
 * in a test of `versions` versions. The headline test's confidence sequence
 * (boundary in lib/headline-test-rules.ts), at that test's share of the 5%,
 * tuned the same way; with two versions it is exactly that line.
 */
export function pairLine(views: number, versions: number): number {
  const alpha = falseWinnerShare(versions);
  // Tuned at the headline test's 5% so the curve keeps its shape; only the share of 5% changes.
  let x = 8;
  for (let i = 0; i < 50; i += 1) x = -2 * Math.log(FALSE_WINNER) + Math.log(1 + x);
  const rho2 = x / TUNED_VIEWS;
  const at = Math.max(1, views) * rho2;
  return Math.sqrt(((2 * (at + 1)) / at) * Math.log(Math.sqrt(at + 1) / alpha));
}

const label = (id: string) => `Version ${id.toUpperCase()}`;
const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function readable(version: AbVersion): boolean {
  if (!version || typeof version !== "object") return false;
  const { visitors, paidOrders, paidCents, refundedOrders, refundedCents, disputedOrders, disputedCents, netSquares } = version;
  if (![visitors, paidOrders, paidCents, refundedOrders, refundedCents, disputedOrders, disputedCents, netSquares].every(whole)) return false;
  if (paidOrders > visitors || refundedOrders + disputedOrders > paidOrders || refundedCents + disputedCents > paidCents) return false;
  // Orders and their money go together: orders with no money, or money with no orders, cannot be true.
  if ((paidOrders === 0) !== (paidCents === 0)) return false;
  if ((refundedOrders === 0) !== (refundedCents === 0)) return false;
  if ((disputedOrders === 0) !== (disputedCents === 0)) return false;
  const net = paidCents - refundedCents - disputedCents;
  // Each order keeps a non-negative amount, so: no money, no squares; and
  // net² / orders ≤ squares ≤ net² (Cauchy–Schwarz and non-negative parts).
  if (net === 0) return netSquares === 0;
  if (netSquares === 0) return false;
  const square = net * net;
  if (!Number.isFinite(square)) return false;
  return netSquares * paidOrders >= square * (1 - 1e-12) && netSquares <= square * (1 + 1e-12);
}

function refused(words: string, reason: "invalid" | "mixed_currencies"): AbVerdict {
  return { result: "no_clear_winner_yet", winner: null, reason, figures: null, words };
}

const CANNOT_READ = "No result: the figures could not be read. Nothing is decided from them.";

/** Money per 100 visitors, as a person reads it. */
const per100 = (figure: AbFigure) => formatMoney(figure.netPer100Cents, figure.currency);

/**
 * Says whether one version has won, or why there is no clear winner yet.
 * It only reports: the caller decides what, if anything, to show or change.
 */
export function abDecision(input: AbInput): AbVerdict {
  if (!input || typeof input !== "object" || !Array.isArray(input.versions)) return refused(CANNOT_READ, "invalid");
  const { versions, startedAt, now, shares } = input;
  const k = versions.length;
  if (k < AB_MIN_VERSIONS || k > AB_MAX_VERSIONS) return refused(CANNOT_READ, "invalid");
  const ids = versions.map((version) => version?.id);
  if (new Set(ids).size !== k || !ids.every((id) => (AB_VERSION_IDS as readonly string[]).includes(id as string))) return refused(CANNOT_READ, "invalid");
  if (!versions.every(readable)) return refused(CANNOT_READ, "invalid");
  if (!versions.every((version) => typeof version.currency === "string" && /^[a-z]{3}$/.test(version.currency))) return refused(CANNOT_READ, "invalid");
  if (!whole(startedAt) || !whole(now) || startedAt <= 0 || startedAt > now) return refused(CANNOT_READ, "invalid");
  let expected: number[];
  if (shares === undefined) expected = versions.map(() => 1 / k);
  else {
    if (!Array.isArray(shares) || shares.length !== k || !shares.every((share) => typeof share === "number" && Number.isFinite(share) && share > 0 && share < 1)) return refused(CANNOT_READ, "invalid");
    if (Math.abs(shares.reduce((sum, share) => sum + share, 0) - 1) > 1e-9) return refused(CANNOT_READ, "invalid");
    expected = shares;
  }
  const currencies = [...new Set(versions.map((version) => version.currency))].sort();
  if (currencies.length > 1) {
    return refused(
      `No result: the versions' sales are in different currencies (${currencies.map((code) => code.toUpperCase()).join(", ")}). Money in two currencies cannot be compared, so nothing is decided.`,
      "mixed_currencies",
    );
  }

  const figures: AbFigure[] = versions.map((version) => {
    const netCents = version.paidCents - version.refundedCents - version.disputedCents;
    return {
      id: version.id,
      label: label(version.id),
      visitors: version.visitors,
      paidOrders: version.paidOrders,
      refundedOrders: version.refundedOrders,
      disputedOrders: version.disputedOrders,
      keptOrders: version.paidOrders - version.refundedOrders - version.disputedOrders,
      paidCents: version.paidCents,
      refundedCents: version.refundedCents,
      disputedCents: version.disputedCents,
      netCents,
      netPer100Cents: version.visitors > 0 ? Math.round((netCents * 100) / version.visitors) : 0,
      currency: version.currency,
    };
  });
  const none = (reason: Exclude<AbReason, "clear_lead">, words: string, extra: Partial<AbVerdict> = {}): AbVerdict => ({
    result: "no_clear_winner_yet",
    winner: null,
    reason,
    figures,
    ...extra,
    words,
  });

  // 1. Enough data in every version.
  const short = figures
    .map((figure) => ({ id: figure.id, visitors: Math.max(0, MIN_VIEWS - figure.visitors), sales: Math.max(0, MIN_SALES - figure.keptOrders) }))
    .filter((need) => need.visitors > 0 || need.sales > 0);
  if (short.length > 0) {
    const needs = short.map((need) => {
      const parts: string[] = [];
      if (need.visitors > 0) parts.push(`${need.visitors} more visitor${need.visitors === 1 ? "" : "s"}`);
      if (need.sales > 0) parts.push(`${need.sales} more sale${need.sales === 1 ? "" : "s"}`);
      return `${label(need.id)} needs ${list(parts)}.`;
    });
    return none(
      "too_few",
      `No clear winner yet: there is not enough data. Each version needs at least ${MIN_VIEWS} visitors and ${MIN_SALES} sales that were not refunded or disputed. ${needs.join(" ")}`,
      { short },
    );
  }

  // 2. Visitors split as expected.
  const total = figures.reduce((sum, figure) => sum + figure.visitors, 0);
  const chi2 = figures.reduce((sum, figure, i) => {
    const want = total * expected[i];
    return sum + (figure.visitors - want) ** 2 / want;
  }, 0);
  if (!Number.isFinite(chi2)) return refused(CANNOT_READ, "invalid");
  if (chi2 > SPLIT_CHI2[k - 1]) {
    return none(
      "split",
      "No clear winner yet: visitors were not split between the versions as expected, so something may be counted wrong. No winner is called while the split is off.",
    );
  }

  // 3. Refunds have had time to come in.
  const waited = now - startedAt;
  if (waited < REFUND_DAYS * DAY) {
    const daysLeft = Math.ceil((REFUND_DAYS * DAY - waited) / DAY);
    return none(
      "refund_window",
      `No clear winner yet: the test must run for ${REFUND_DAYS} days so refunds can be counted. ${daysLeft} day${daysLeft === 1 ? "" : "s"} to go.`,
      { daysLeft },
    );
  }

  // 4. The leader, net of refunds and disputes, per visitor (exact comparison: net·visitors cross-multiplied).
  const ahead = (i: number, j: number) => figures[i].netCents * figures[j].visitors - figures[j].netCents * figures[i].visitors;
  let best = 0;
  for (let i = 1; i < k; i += 1) if (ahead(i, best) > 0) best = i;
  const tied = figures.filter((_, i) => i !== best && ahead(i, best) === 0).map((figure) => figure.id);
  if (tied.length > 0) {
    const ids = [figures[best].id, ...tied].sort();
    return none(
      "tie",
      `No clear winner yet. ${list(ids.map(label))} brought exactly the same money per 100 visitors after refunds and disputes: ${per100(figures[best])}.`,
      { tied: ids },
    );
  }

  // 5. The leader's lead over every other version, against the line.
  const meanAndVariance = (i: number) => {
    const visitors = versions[i].visitors;
    const mean = figures[i].netCents / visitors;
    return { mean, variance: Math.max(0, versions[i].netSquares / visitors - mean * mean), visitors };
  };
  const lead = meanAndVariance(best);
  const comparisons: AbComparison[] = [];
  for (let j = 0; j < k; j += 1) {
    if (j === best) continue;
    const other = meanAndVariance(j);
    const se = Math.sqrt(lead.variance / lead.visitors + other.variance / other.visitors);
    const z = se > 0 ? (lead.mean - other.mean) / se : 0;
    const line = pairLine(lead.visitors + other.visitors, k);
    if (!Number.isFinite(z) || !Number.isFinite(line)) return refused(CANNOT_READ, "invalid");
    comparisons.push({ against: figures[j].id, z, line });
  }
  const close = comparisons.filter((comparison) => comparison.z < comparison.line).map((comparison) => comparison.against);
  if (close.length > 0) {
    const stricter = k > 2 ? ` With ${k} versions, each lead must be larger than with 2, so that a false winner stays at most ${FALSE_WINNER * 100}% likely.` : "";
    return none(
      "too_close",
      `No clear winner yet. ${label(figures[best].id)} is ahead after refunds and disputes, but its lead over ${list(close.map(label))} is still small enough to be chance.${stricter}`,
      { comparisons, close },
    );
  }

  const others = figures.filter((_, i) => i !== best).map((figure) => `${per100(figure)} for ${figure.label}`);
  return {
    result: "winner",
    winner: figures[best].id,
    reason: "clear_lead",
    figures,
    comparisons,
    words: `${label(figures[best].id)} is the winner. After refunds and disputes, it brought the most money per 100 visitors: ${per100(figures[best])}, against ${list(others)}. Its lead over every other version is large enough that chance alone is unlikely: the rule allows at most a ${FALSE_WINNER * 100}% chance of a false winner over the whole test. This shows what happened during the test. It is not a promise of future sales.`,
  };
}
