/**
 * The ads autopilot's rules: 632 [AA2] (h), unit 5 (owner, 2 November 2026).
 * Pure; nothing here calls an ad platform or changes a campaign.
 *
 * The creator approves limits once — the most all autopilot campaigns may
 * have as daily budgets, the most they may spend in the next seven days at
 * the platforms' worst, the most in all, the most a sale may cost, and which
 * networks and products it may touch — and `autopilotChanges` says what to
 * change today so that the campaigns that pay for themselves get more and
 * the ones that do not are paused, never past a limit:
 *
 *   - Only campaigns on an allowed network for an allowed product are its
 *     own; any other is left exactly as it is.
 *   - A campaign is judged only once it has spent at least twice the most a
 *     sale may cost (`judged`); before that, and whenever its sales are not
 *     measured (null), it is held: nothing is said about a result that was
 *     not measured, and an unknown is never read as zero sales.
 *   - Paused: a judged campaign whose cost per sale, after refunds, is above
 *     the most a sale may cost (or that has no sale).
 *   - Raised by at most RAISE_PERCENT a day: a judged campaign with at least
 *     MIN_SALES_TO_RAISE sales costing at most RAISE_BELOW_PERCENT of the most
 *     a sale may cost; the best first, each only as far as every limit allows.
 *   - Lowered: when today's budgets already pass a limit (the creator lowered
 *     it, or a campaign was changed elsewhere), the dearest per sale are
 *     lowered first, then paused, until every limit holds.
 *   - The worst case is the platforms' own (lib/ad-campaign-plan.ts,
 *     worstCaseCents): Meta up to 1.75 × a daily budget on a day and 7 × in a
 *     week, Google 2 × on a day; never the budget alone.
 *
 * Each change carries its before and after, so it goes into "What the AI did"
 * (631 [AA1], lib/agent-proposal-rules.ts) with undo. In "approve" mode every
 * change waits for the creator; in "auto" mode the ones inside the approved
 * limits are carried out, and the creator can switch back at any time.
 */
import type { ProposalKind } from "@/lib/agent-proposal-rules";
import { type AdPlatform, dailyBudgetAllowed, worstCaseCents } from "@/lib/ad-campaign-plan";

/** The most a daily budget is raised in one day, in percent. */
export const RAISE_PERCENT = 20;
/** A campaign is raised only when its cost per sale is at most this share of the most allowed, in percent. */
export const RAISE_BELOW_PERCENT = 70;
/** And only with at least this many sales measured. */
export const MIN_SALES_TO_RAISE = 3;
/** Spent at least this many times the most a sale may cost before a campaign is judged. */
export const JUDGE_AFTER_TIMES = 2;

export type AutopilotRules = {
  mode: "auto" | "approve";
  /** The most all its campaigns' daily budgets may add up to. */
  maxDailyCents: number;
  /** The most all its campaigns may spend in the next seven days, at the platforms' worst. */
  maxWeekCents: number;
  /** The most all its campaigns may spend in all: what they spent, and the worst of their remaining days. */
  maxTotalCents: number;
  /** The most one sale may cost in ad spend, after refunds. */
  maxCostPerSaleCents: number;
  platforms: readonly AdPlatform[];
  products: readonly string[];
};

export type CampaignNow = {
  id: string;
  platform: AdPlatform;
  product: string;
  status: "ACTIVE" | "PAUSED";
  dailyBudgetCents: number;
  /** Spent so far, read from the creator's ad account. */
  spentCents: number;
  /** Sales after refunds and disputes, attributed to it; null when not measured. */
  sales: number | null;
  /** Today, as a day number (days since 1970-01-01, UTC), and the days left including today. */
  today: number;
  daysLeft: number;
};

export type ChangeKind = "pause" | "raise" | "lower";
export type CampaignSetting = { status: "ACTIVE" | "PAUSED"; dailyBudgetCents: number };
export type AutopilotChange = {
  kind: ChangeKind;
  campaign: string;
  before: CampaignSetting;
  after: CampaignSetting;
  /** In plain words, for the creator and the history. */
  why: string;
  /** Carried out now (auto mode) or waiting for the creator (approve mode). */
  apply: "now" | "ask";
};

/** How a change is kept in "What the AI did": it reaches money, so one at a time, and it can be put back. */
export const AUTOPILOT_KIND: ProposalKind = { name: "ads.campaign", scope: "execute", undo: true, maxBytes: 2_000 };

export type RulesRefusal = "mode" | "daily" | "week" | "total" | "cost" | "scope";

/** Whether a set of limits can be approved; every limit set, whole, above zero. */
export function checkRules(rules: AutopilotRules): { ok: true } | { ok: false; error: RulesRefusal } {
  if (rules.mode !== "auto" && rules.mode !== "approve") return { ok: false, error: "mode" };
  if (!dailyBudgetAllowed(rules.maxDailyCents)) return { ok: false, error: "daily" };
  const whole = (n: number) => Number.isSafeInteger(n) && n > 0;
  if (!whole(rules.maxWeekCents)) return { ok: false, error: "week" };
  if (!whole(rules.maxTotalCents)) return { ok: false, error: "total" };
  if (!whole(rules.maxCostPerSaleCents)) return { ok: false, error: "cost" };
  if (!rules.platforms.length || !rules.products.length) return { ok: false, error: "scope" };
  return { ok: true };
}

const live = (c: { status: string; dailyBudgetCents: number }) => (c.status === "ACTIVE" ? c.dailyBudgetCents : 0);
/** Its worst spend in the next seven days (or fewer, if it ends sooner). */
const weekWorst = (c: CampaignNow, daily: number) => (daily > 0 ? worstCaseCents(c.platform, daily, c.today, Math.min(7, Math.max(0, c.daysLeft))) : 0);
/** What it spent and the worst of its remaining days. */
const totalWorst = (c: CampaignNow, daily: number) => c.spentCents + (daily > 0 ? worstCaseCents(c.platform, daily, c.today, Math.max(0, c.daysLeft)) : 0);

/** Whether a set of daily budgets (0 for paused) keeps every limit. */
export function withinLimits(rules: AutopilotRules, campaigns: readonly CampaignNow[], daily: ReadonlyMap<string, number>): boolean {
  let day = 0;
  let week = 0;
  let total = 0;
  for (const c of campaigns) {
    const d = daily.get(c.id) ?? 0;
    day += d;
    week += weekWorst(c, d);
    total += totalWorst(c, d);
  }
  return day <= rules.maxDailyCents && week <= rules.maxWeekCents && total <= rules.maxTotalCents;
}

const costPerSale = (c: CampaignNow) => (c.sales && c.sales > 0 ? c.spentCents / c.sales : Infinity);
const judged = (c: CampaignNow, rules: AutopilotRules) => c.sales !== null && c.spentCents >= JUDGE_AFTER_TIMES * rules.maxCostPerSaleCents;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** What to change today, within the approved limits; the campaigns it does not own are never in it. */
export function autopilotChanges(rules: AutopilotRules, campaigns: readonly CampaignNow[]): AutopilotChange[] {
  if (!checkRules(rules).ok) return [];
  const own = campaigns.filter((c) => rules.platforms.includes(c.platform) && rules.products.includes(c.product) && c.daysLeft > 0);
  const daily = new Map(own.map((c) => [c.id, live(c)] as const));
  const why = new Map<string, string>();

  // 1. Pause what does not pay for itself, once it has been measured enough to say so.
  for (const c of own) {
    if (live(c) === 0 || !judged(c, rules)) continue;
    const cps = costPerSale(c);
    if (cps > rules.maxCostPerSaleCents) {
      daily.set(c.id, 0);
      why.set(c.id, c.sales ? `Each sale cost ${money(Math.ceil(cps))} in ads after refunds, above your most of ${money(rules.maxCostPerSaleCents)}.` : `It spent ${money(c.spentCents)} with no sale after refunds.`);
    }
  }

  // 2. Bring what is already over a limit back inside: the dearest per sale first, lowered by halves, then paused.
  const byCost = [...own].sort((a, b) => costPerSale(b) - costPerSale(a) || a.id.localeCompare(b.id));
  for (let guard = 0; guard < 64 && !withinLimits(rules, own, daily); guard += 1) {
    const next = byCost.find((c) => (daily.get(c.id) ?? 0) > 0);
    if (!next) break;
    const now = daily.get(next.id)!;
    const half = Math.floor(now / 2);
    daily.set(next.id, half >= 100 ? half : 0);
    why.set(next.id, "Your limits were passed by today's budgets; this campaign costs the most per sale, so it gives way first.");
  }

  // 3. Raise what pays for itself best, each only as far as every limit still holds.
  const winners = own
    .filter((c) => (daily.get(c.id) ?? 0) > 0 && !why.has(c.id) && judged(c, rules) && (c.sales ?? 0) >= MIN_SALES_TO_RAISE && costPerSale(c) * 100 <= rules.maxCostPerSaleCents * RAISE_BELOW_PERCENT)
    .sort((a, b) => costPerSale(a) - costPerSale(b) || a.id.localeCompare(b.id));
  for (const c of winners) {
    const from = daily.get(c.id)!;
    let low = from;
    let high = Math.floor((from * (100 + RAISE_PERCENT)) / 100);
    // The largest budget up to +RAISE_PERCENT that keeps every limit, found by halving.
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      daily.set(c.id, mid);
      if (dailyBudgetAllowed(mid) && withinLimits(rules, own, daily)) low = mid;
      else high = mid - 1;
    }
    daily.set(c.id, low);
    if (low > from) why.set(c.id, `Each sale cost ${money(Math.ceil(costPerSale(c)))} in ads after refunds, well under your most of ${money(rules.maxCostPerSaleCents)}.`);
  }

  const out: AutopilotChange[] = [];
  for (const c of own) {
    const before: CampaignSetting = { status: c.status, dailyBudgetCents: c.dailyBudgetCents };
    const target = daily.get(c.id)!;
    if (target === live(c)) continue;
    const after: CampaignSetting = target === 0 ? { status: "PAUSED", dailyBudgetCents: c.dailyBudgetCents } : { status: "ACTIVE", dailyBudgetCents: target };
    const kind: ChangeKind = target === 0 ? "pause" : target > live(c) ? "raise" : "lower";
    out.push({ kind, campaign: c.id, before, after, why: why.get(c.id) ?? "", apply: rules.mode === "auto" ? "now" : "ask" });
  }
  return out;
}
