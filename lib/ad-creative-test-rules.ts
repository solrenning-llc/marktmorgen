/**
 * Testing ad versions: 632 [AA2] (i), unit 6 (owner, 2 November 2026). Pure;
 * nothing here calls an ad platform.
 *
 * A campaign runs two to MAX_VERSIONS versions of its words, picture or
 * video, and its daily budget is shared between them. `creativeTest` says
 * how to share it today and what may honestly be said about them:
 *
 *   - Until it is measured, nothing is said: every version keeps an equal
 *     share while any of them has less than MIN_SALES_EACH sales after
 *     refunds, or its sales are not measured (null is never read as none).
 *   - A version "sells more" only when its sales per dollar after refunds are
 *     higher than every other's by a clear margin: the difference of the two
 *     rates is at least Z_NEEDED standard errors (counts of sales read as
 *     Poisson, rate = sales ÷ spend). Otherwise "no clear difference yet",
 *     whatever the figures look like.
 *   - The budget then moves to it gradually, at most SHIFT_POINTS of the
 *     budget a day, and never past WINNER_MOST percent, so the others still
 *     run a little and a change in the weather can still be seen.
 *   - The campaign's daily budget is never changed here: the shares always
 *     add up to exactly it, so every limit of the campaign plan
 *     (lib/ad-campaign-plan.ts) and of the autopilot holds as it was.
 *   - No prediction: what is said is what was measured, with the counts.
 */

export const MAX_VERSIONS = 6;
/** Sales after refunds each version needs before any is said to sell more. */
export const MIN_SALES_EACH = 5;
/** How many standard errors apart two rates must be (about 97.5% one-sided). */
export const Z_NEEDED = 1.96;
/** The most of the budget that moves in a day, in percentage points. */
export const SHIFT_POINTS = 20;
/** The most of the budget the leading version is given, in percent. */
export const WINNER_MOST = 80;

export type Version = {
  id: string;
  /** Spent on it so far, in the ad account's smallest unit. */
  spentCents: number;
  /** Sales after refunds and disputes attributed to it; null when not measured. */
  sales: number | null;
  /** Its share of the daily budget today, in percent (the shares add up to 100). */
  sharePercent: number;
};

export type TestRefusal = "count" | "ids" | "shares" | "budget";

export type TestResult =
  | {
      ok: true;
      /** "learning": not measured enough; "no_difference": measured, no clear leader; "leader": one sells more. */
      state: "learning" | "no_difference" | "leader";
      leader: string | null;
      /** Tomorrow's shares, in percent, adding up to 100, in the order given. */
      shares: { id: string; sharePercent: number; dailyCents: number }[];
      /** What may be said, in plain words, with the counts. */
      says: string;
    }
  | { ok: false; error: TestRefusal };

const rate = (v: Version) => (v.sales ?? 0) / Math.max(v.spentCents, 1);
/** Standard errors between two rates of sales per cent spent, sales read as Poisson counts. */
export function zBetween(a: { sales: number; spentCents: number }, b: { sales: number; spentCents: number }): number {
  if (a.spentCents <= 0 || b.spentCents <= 0) return 0;
  const ra = a.sales / a.spentCents;
  const rb = b.sales / b.spentCents;
  const se = Math.sqrt(a.sales / a.spentCents ** 2 + b.sales / b.spentCents ** 2);
  return se > 0 ? (ra - rb) / se : 0;
}

/** Whole percents adding up to exactly 100, as near the wanted ones as possible (largest remainder). */
function wholeShares(wanted: number[]): number[] {
  const floor = wanted.map(Math.floor);
  let left = 100 - floor.reduce((s, n) => s + n, 0);
  const order = wanted.map((w, i) => [w - Math.floor(w), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floor[i] += 1;
    left -= 1;
  }
  return floor;
}

/** Cents of a daily budget for each share, adding up to exactly the budget. */
function centsOf(dailyCents: number, shares: number[]): number[] {
  const out = shares.map((s) => Math.floor((dailyCents * s) / 100));
  let left = dailyCents - out.reduce((s, n) => s + n, 0);
  for (let i = 0; left > 0; i = (i + 1) % out.length) {
    if (shares[i] > 0) {
      out[i] += 1;
      left -= 1;
    }
  }
  return out;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Today's verdict and tomorrow's shares of one campaign's daily budget. */
export function creativeTest(dailyCents: number, versions: readonly Version[]): TestResult {
  if (versions.length < 2 || versions.length > MAX_VERSIONS) return { ok: false, error: "count" };
  if (new Set(versions.map((v) => v.id)).size !== versions.length || versions.some((v) => !v.id)) return { ok: false, error: "ids" };
  if (versions.some((v) => !Number.isInteger(v.sharePercent) || v.sharePercent < 0) || versions.reduce((s, v) => s + v.sharePercent, 0) !== 100) return { ok: false, error: "shares" };
  if (!Number.isSafeInteger(dailyCents) || dailyCents < versions.length) return { ok: false, error: "budget" };

  const equal = wholeShares(versions.map(() => 100 / versions.length));
  const keep = (state: "learning" | "no_difference", says: string): TestResult => {
    // Back toward equal shares, every share the same part of the way, so no
    // share moves more than SHIFT_POINTS a day and they still add up to 100:
    // nothing is favored without a measured reason.
    const farthest = Math.max(...versions.map((v, i) => Math.abs(equal[i] - v.sharePercent)));
    const step = farthest > SHIFT_POINTS ? SHIFT_POINTS / farthest : 1;
    const toward = wholeShares(versions.map((v, i) => v.sharePercent + step * (equal[i] - v.sharePercent)));
    const cents = centsOf(dailyCents, toward);
    return { ok: true, state, leader: null, shares: versions.map((v, i) => ({ id: v.id, sharePercent: toward[i], dailyCents: cents[i] })), says };
  };

  const unmeasured = versions.filter((v) => v.sales === null);
  if (unmeasured.length) return keep("learning", "Not measured yet: the sales of some versions could not be read, so none is said to sell more.");
  const short = versions.filter((v) => (v.sales ?? 0) < MIN_SALES_EACH);
  if (short.length) return keep("learning", `Still learning: each version needs at least ${MIN_SALES_EACH} sales after refunds before any is said to sell more.`);

  const ranked = [...versions].sort((a, b) => rate(b) - rate(a) || a.id.localeCompare(b.id));
  const top = ranked[0];
  const clear = ranked.slice(1).every((v) => zBetween({ sales: top.sales!, spentCents: top.spentCents }, { sales: v.sales!, spentCents: v.spentCents }) >= Z_NEEDED);
  if (!clear) return keep("no_difference", "No clear difference yet: the versions' sales per dollar after refunds are too close to tell apart.");

  // The leader gains up to SHIFT_POINTS, never past WINNER_MOST; the others give it up in proportion to their shares.
  const at = versions.findIndex((v) => v.id === top.id);
  const gain = Math.max(0, Math.min(SHIFT_POINTS, WINNER_MOST - versions[at].sharePercent));
  const othersTotal = 100 - versions[at].sharePercent;
  const wanted = versions.map((v, i) => (i === at ? v.sharePercent + gain : othersTotal > 0 ? v.sharePercent - (gain * v.sharePercent) / othersTotal : 0));
  const shares = wholeShares(wanted);
  const cents = centsOf(dailyCents, shares);
  const second = ranked[1];
  return {
    ok: true,
    state: "leader",
    leader: top.id,
    shares: versions.map((v, i) => ({ id: v.id, sharePercent: shares[i], dailyCents: cents[i] })),
    says: `Version ${top.id} sells more per dollar after refunds: ${top.sales} sales for ${money(top.spentCents)}, against ${second.sales} for ${money(second.spentCents)} for the next. It gets more of the budget, a step a day.`,
  };
}
