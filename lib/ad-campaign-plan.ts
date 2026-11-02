/**
 * A campaign as Marktmorgen would create it in the creator's own ad account:
 * 632 [AA2] (b), unit 3 (owner, 2 November 2026). Pure rules, from what the
 * official check confirmed (docs/ad-platforms-official-check-2026-11-02.md);
 * nothing here calls an ad platform.
 *
 *   - Every campaign is created PAUSED and is activated only by the creator's
 *     confirmation of exactly the maximum shown to them (`activationAllowed`):
 *     a plan whose words or numbers changed after it was shown cannot be
 *     activated with the old confirmation.
 *   - Every campaign has an end date, so its spend is never unbounded.
 *   - The maximum shown is the worst case the platform's own rules allow, not
 *     the budget alone: Meta up to 1.75 × the daily budget on a day and 7 × in
 *     a week (Sunday to Saturday), and never more than daily × days for a
 *     campaign under 7 days; Google up to 2 × on a day and 30.4 × in a month;
 *     TikTok up to 1.25 × on a day and 7 × in a week. Rounded up to the cent.
 *   - The creator's own total limit is a wall: a plan whose worst case passes
 *     it is refused, with what to change.
 *   - Meta's "high demand periods" (up to 8 × the daily budget) are never used:
 *     there is no field for them here.
 *   - TikTok is refused for now: whether a campaign can be created disabled
 *     was NOT FOUND in the official check, and nothing is created live.
 *
 * The money is always the creator's, in their own ad account: Marktmorgen
 * never pays, advances, receives or holds it.
 */
import { createHash } from "node:crypto";

export type AdPlatform = "meta" | "google" | "tiktok";

export type CampaignInput = {
  platform: AdPlatform;
  /** The daily budget, in the smallest unit of the ad account's currency. */
  dailyBudgetCents: number;
  /** First and last day, inclusive, YYYY-MM-DD, in the ad account's time zone. */
  start: string;
  end: string;
  /** The most the creator lets this campaign spend in all, same unit. */
  creatorTotalLimitCents: number;
  currency: string;
};

/** The longest campaign planned here, in days. */
export const MAX_CAMPAIGN_DAYS = 366;
/** The largest daily budget accepted here, in the smallest unit: a wall against a typo. */
export const MAX_DAILY_CENTS = 10_000_000;

/** Worst case per day and per period, as numerator/denominator, from the official check. */
const CEILINGS: Readonly<Record<Exclude<AdPlatform, "tiktok">, { day: [number, number]; period: "week" | "month"; periodTimes: [number, number] }>> = {
  meta: { day: [7, 4], period: "week", periodTimes: [7, 1] },
  google: { day: [2, 1], period: "month", periodTimes: [152, 5] },
};
const TIKTOK = { day: [5, 4] as [number, number], period: "week" as const, periodTimes: [7, 1] as [number, number] };

export type PlanRefusal =
  | "tiktok_status_unconfirmed"
  | "dates"
  | "order"
  | "too_long"
  | "budget"
  | "limit"
  | "over_limit";

export type CampaignPlan = {
  platform: AdPlatform;
  status: "PAUSED";
  dailyBudgetCents: number;
  start: string;
  end: string;
  days: number;
  currency: string;
  creatorTotalLimitCents: number;
  /** The most the platform's own rules let this campaign spend, rounded up: what the creator is shown. */
  maxSpendCents: number;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (date: string): number | null => {
  if (!DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? ms / 86_400_000 : null;
};
const ceilTimes = (cents: number, [n, d]: [number, number], units = 1) => Math.ceil((cents * n * units) / d);

/** The worst-case spend of `days` days from day number `first`, for a platform's ceilings. */
export function worstCaseCents(platform: AdPlatform, dailyCents: number, first: number, days: number): number {
  const c = platform === "tiktok" ? TIKTOK : CEILINGS[platform];
  // Meta: a campaign shorter than 7 days never spends more than daily × its days.
  if (platform === "meta" && days < 7) return dailyCents * days;
  const groups = new Map<string, number>();
  for (let i = 0; i < days; i += 1) {
    const day = new Date((first + i) * 86_400_000);
    // Weeks run Sunday to Saturday; months are calendar months.
    const key = c.period === "week" ? String(first + i - day.getUTCDay()) : day.toISOString().slice(0, 7);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  let total = 0;
  for (const k of groups.values()) total += Math.min(ceilTimes(dailyCents, c.day, k), ceilTimes(dailyCents, c.periodTimes));
  return total;
}

/** A campaign plan, created PAUSED, or why it cannot be one. */
export function planCampaign(input: CampaignInput): { ok: true; plan: CampaignPlan } | { ok: false; error: PlanRefusal; fix: string } {
  if (input.platform === "tiktok") return { ok: false, error: "tiktok_status_unconfirmed", fix: "TikTok campaigns come once it is confirmed that one can be created switched off." };
  const first = dayNumber(input.start);
  const last = dayNumber(input.end);
  if (first === null || last === null) return { ok: false, error: "dates", fix: "Choose a first and a last day." };
  if (last < first) return { ok: false, error: "order", fix: "The last day must not be before the first." };
  const days = last - first + 1;
  if (days > MAX_CAMPAIGN_DAYS) return { ok: false, error: "too_long", fix: `Plan at most ${MAX_CAMPAIGN_DAYS} days; start another campaign after.` };
  if (!Number.isSafeInteger(input.dailyBudgetCents) || input.dailyBudgetCents <= 0 || input.dailyBudgetCents > MAX_DAILY_CENTS) return { ok: false, error: "budget", fix: "Choose a daily budget above zero." };
  if (!Number.isSafeInteger(input.creatorTotalLimitCents) || input.creatorTotalLimitCents <= 0) return { ok: false, error: "limit", fix: "Choose the most this campaign may spend in all." };
  const maxSpendCents = worstCaseCents(input.platform, input.dailyBudgetCents, first, days);
  if (maxSpendCents > input.creatorTotalLimitCents) {
    return { ok: false, error: "over_limit", fix: "On its worst days the platform could spend more than your limit: lower the daily budget, shorten the dates or raise your limit." };
  }
  return {
    ok: true,
    plan: { platform: input.platform, status: "PAUSED", dailyBudgetCents: input.dailyBudgetCents, start: input.start, end: input.end, days, currency: input.currency.toLowerCase(), creatorTotalLimitCents: input.creatorTotalLimitCents, maxSpendCents },
  };
}

/** A fingerprint of everything in a plan, so a confirmation is for exactly that plan. */
export function planHash(plan: CampaignPlan): string {
  const keys = Object.keys(plan).sort() as (keyof CampaignPlan)[];
  return createHash("sha256").update(JSON.stringify(keys.map((k) => [k, plan[k]]))).digest("hex");
}

export type Confirmation = { planHash: string; shownMaxCents: number };

/** Whether the creator's confirmation activates this plan: the same plan, and the very maximum they were shown. */
export function activationAllowed(plan: CampaignPlan, confirmation: Confirmation | null | undefined): boolean {
  return Boolean(confirmation) && plan.status === "PAUSED" && confirmation!.planHash === planHash(plan) && confirmation!.shownMaxCents === plan.maxSpendCents;
}
