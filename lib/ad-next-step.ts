/**
 * The next step for one ad campaign, from the store's own measured numbers:
 * 632 [AA2] (o) (owner, 2 November 2026, 02h18 Fortaleza): "esta campanha se
 * pagou em 4 dias; aumentar o orçamento em 20% dentro do seu limite?", with
 * the button that prepares the change. This is the rule only; the screen that
 * shows it comes later.
 *
 *   - Paid for itself: from the first day of its ads inside the days shown,
 *     its sales less the refunds of its sales, day by day, add up to all it
 *     spent, and stay there to the last day (a later refund that takes it
 *     back under undoes the payback). Read as lib/ad-spend-rules.ts
 *     (paybackOf) reads a channel, with refunds taken off, and only once at
 *     least VERDICT_MIN_CENTS was spent.
 *   - Unknown: the numbers are partial, the store's sales, the campaign's
 *     sales or its refunds were not read in full, or no spend (or too little)
 *     was recorded. Then it says it is unknown, gives no figure and suggests
 *     nothing; an unknown is never read as zero.
 *   - A raise is prepared only for an active campaign that paid for itself
 *     with at least MIN_SALES_TO_RAISE sales, each costing at most the
 *     creator's most per sale, and only as far as every limit the creator
 *     approved holds (lib/ad-autopilot-rules.ts, withinLimits: daily budgets,
 *     the platforms' worst week and the worst total) and never by more than
 *     RAISE_PERCENT. Without approved limits nothing is raised.
 *   - A pause is prepared only for an active campaign that did not pay for
 *     itself once it spent JUDGE_AFTER_TIMES the creator's most per sale.
 *   - Every prepared change waits for the creator ("ask"): this rule changes
 *     nothing, calls nothing and spends nothing. It never promises what a
 *     change would bring; it says what was measured and what would change.
 *
 * The sentences are in plain American English and pass the ad honesty check
 * (lib/ad-creative-check.ts): no promise of gain and no urgency
 * (tests/ad-next-step.test.ts).
 */
import { type AutopilotRules, type CampaignNow, type CampaignSetting, JUDGE_AFTER_TIMES, MIN_SALES_TO_RAISE, RAISE_PERCENT, checkRules, withinLimits } from "@/lib/ad-autopilot-rules";
import { dailyBudgetAllowed } from "@/lib/ad-campaign-plan";
import type { CampaignResults } from "@/lib/campaign-results";
import { type AdSpend, VERDICT_MIN_CENTS, daysBetween, spendWithin } from "@/lib/ad-spend-rules";
import { formatMoney } from "@/lib/money";

export type NextStepInput = {
  /** The campaign tag the store's numbers count it by (utm_campaign), as in lib/campaign-results.ts. */
  name: string;
  /** The campaign as the creator's ad account has it now. */
  campaign: CampaignNow;
  /** The store's currency, the unit of every amount here. */
  currency: string;
  /** The days measured, both counted, YYYY-MM-DD. */
  from: string;
  to: string;
  /** Whether the store's numbers over those days were read in full (lib/campaign-results.ts). */
  results: Pick<CampaignResults, "partial" | "salesKnown">;
  /** Ad spend lines, read from the ad account or typed; only this campaign's count. */
  spends: readonly AdSpend[];
  /** The money its sales brought on each day; null when not measured. Days with nothing are left out. */
  salesByDay: Readonly<Record<string, number>> | null;
  /** The money refunded or disputed from its sales on each day; null when refunds were not read. */
  refundsByDay: Readonly<Record<string, number>> | null;
  /** The limits the creator approved once (lib/ad-autopilot-rules.ts); null when none was chosen. */
  limits: AutopilotRules | null;
  /** Every campaign under those limits; this one is counted whether or not it is listed. */
  all: readonly CampaignNow[];
};

export type NextStepUnknown = "days" | "partial" | "sales" | "refunds" | "spend" | "little";

/** What the creator reads when a figure is unknown: no number, no suggestion. */
export const NEXT_STEP_UNKNOWN: Readonly<Record<NextStepUnknown, string>> = {
  days: "Unknown: these days could not be read, so no change is suggested.",
  partial: "Unknown: the numbers for these days are not complete, so no change is suggested.",
  sales: "Unknown: this campaign's sales were not fully read, so no change is suggested.",
  refunds: "Unknown: refunds were not fully read, so no change is suggested.",
  spend: "Unknown: no ad spend is recorded for this campaign, so no change is suggested.",
  little: "Unknown: too little was spent on its ads to judge, so no change is suggested.",
};

export type NextStepChange = {
  kind: "raise" | "pause";
  campaign: string;
  before: CampaignSetting;
  after: CampaignSetting;
  /** Always waits for the creator's confirmation; this rule changes nothing. */
  apply: "ask";
  /** What changes, in plain words, and that it waits for the creator. */
  what: string;
};

export type NextStep = {
  campaign: string;
  state: "unknown" | "paid_back" | "not_paid_back";
  unknown: NextStepUnknown | null;
  /** Spent on its ads over the days measured; null when unknown. */
  spentCents: number | null;
  /** Its sales less refunds since its first day of ads; null when unknown. */
  backCents: number | null;
  /** Days it took to pay for itself, counting the first; null when it did not or when unknown. */
  days: number | null;
  /** The measured facts, in one sentence. */
  says: string;
  /** Why no change is prepared, when there is a reason worth saying. */
  note: string | null;
  /** The question beside the button that prepares the change; null without a change. */
  ask: string | null;
  change: NextStepChange | null;
};

const DAY_MS = 86_400_000;
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** The next step for one campaign; nothing is changed by it. */
export function nextStepFor(input: NextStepInput): NextStep {
  const name = input.campaign.id;
  const unknown = (reason: NextStepUnknown): NextStep => ({ campaign: name, state: "unknown", unknown: reason, spentCents: null, backCents: null, days: null, says: NEXT_STEP_UNKNOWN[reason], note: null, ask: null, change: null });
  const span = daysBetween(input.from, input.to);
  if (!span || span > 400) return unknown("days");
  if (input.results.partial) return unknown("partial");
  if (!input.results.salesKnown || input.salesByDay === null || input.campaign.sales === null) return unknown("sales");
  if (input.refundsByDay === null) return unknown("refunds");

  let spent = 0;
  let first = input.to;
  for (const entry of input.spends) {
    if (entry.campaign !== input.name) continue;
    const cents = spendWithin(entry, input.from, input.to);
    if (cents <= 0) continue;
    spent += cents;
    if (entry.from < first) first = entry.from;
  }
  if (spent <= 0) return unknown("spend");
  if (spent < VERDICT_MIN_CENTS) return unknown("little");

  // From its first day of ads, sales less refunds day by day; paid back from the first day the sum reaches
  // the spend and stays there to the last day.
  const start = first > input.from ? first : input.from;
  let back = 0;
  let count = 0;
  let paidAt: number | null = null;
  for (let day = start; day <= input.to && count < 401; day = nextDay(day)) {
    count += 1;
    back += (input.salesByDay[day] ?? 0) - (input.refundsByDay[day] ?? 0);
    if (back >= spent) paidAt ??= count;
    else paidAt = null;
  }

  const money = (cents: number) => formatMoney(cents, input.currency);
  const c = input.campaign;
  const active = c.status === "ACTIVE" && c.daysLeft > 0;
  const rules = input.limits && checkRules(input.limits).ok ? input.limits : null;
  const facts = { campaign: name, unknown: null, spentCents: spent, backCents: back };

  if (paidAt !== null) {
    const says = `This campaign paid for itself in ${paidAt} ${paidAt === 1 ? "day" : "days"}: ${money(spent)} of ads, ${money(back)} back after refunds.`;
    const step = (note: string | null): NextStep => ({ ...facts, state: "paid_back", days: paidAt, says, note, ask: null, change: null });
    if (c.status !== "ACTIVE") return step("It is paused, so no change is suggested.");
    if (!active) return step(null);
    if (!rules) return step("Choose your ad limits first, so any change stays inside them.");
    const sales = c.sales ?? 0;
    if (sales < MIN_SALES_TO_RAISE) return step(`It has ${sales} ${sales === 1 ? "sale" : "sales"} so far. A raise is suggested only once it has ${MIN_SALES_TO_RAISE}.`);
    if (spent > rules.maxCostPerSaleCents * sales) return step(`Each sale cost more in ads than your most of ${money(rules.maxCostPerSaleCents)}, so no raise is suggested.`);
    const from = c.dailyBudgetCents;
    const to = largestRaise(rules, input.all, c);
    if (to * 100 < from * 101) return step("Your ad limits leave no room to raise its budget.");
    const percent = Math.floor(((to - from) * 100) / from);
    return {
      ...step(null),
      ask: `Raise its daily budget by ${percent}%, from ${money(from)} to ${money(to)}, within your limits?`,
      change: {
        kind: "raise",
        campaign: name,
        before: { status: "ACTIVE", dailyBudgetCents: from },
        after: { status: "ACTIVE", dailyBudgetCents: to },
        apply: "ask",
        what: `Its daily budget goes from ${money(from)} to ${money(to)} only after you confirm. Nothing changes before that.`,
      },
    };
  }

  const says = `This campaign has not paid for itself yet: ${money(spent)} of ads, ${money(back)} back after refunds.`;
  const step = (note: string | null): NextStep => ({ ...facts, state: "not_paid_back", days: null, says, note, ask: null, change: null });
  if (!active || !rules) return step(null);
  const judgeAt = JUDGE_AFTER_TIMES * rules.maxCostPerSaleCents;
  if (spent < judgeAt) return step(`It is too early to judge: wait until it spends ${money(judgeAt)}.`);
  return {
    ...step(null),
    ask: "Pause this campaign?",
    change: {
      kind: "pause",
      campaign: name,
      before: { status: "ACTIVE", dailyBudgetCents: c.dailyBudgetCents },
      after: { status: "PAUSED", dailyBudgetCents: c.dailyBudgetCents },
      apply: "ask",
      what: `It stops showing only after you confirm. Its daily budget stays at ${money(c.dailyBudgetCents)}, and you can switch it back on.`,
    },
  };
}

/** The largest daily budget up to +RAISE_PERCENT that keeps every approved limit with the other campaigns as they are. */
function largestRaise(rules: AutopilotRules, all: readonly CampaignNow[], c: CampaignNow): number {
  const list = [...all.filter((x) => x.id !== c.id), c];
  const daily = new Map(list.map((x) => [x.id, x.status === "ACTIVE" && x.daysLeft > 0 ? x.dailyBudgetCents : 0] as const));
  const from = c.dailyBudgetCents;
  if (!withinLimits(rules, list, daily)) return from;
  let low = from;
  let high = Math.floor((from * (100 + RAISE_PERCENT)) / 100);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    daily.set(c.id, mid);
    if (dailyBudgetAllowed(mid) && withinLimits(rules, list, daily)) low = mid;
    else high = mid - 1;
  }
  return low;
}
