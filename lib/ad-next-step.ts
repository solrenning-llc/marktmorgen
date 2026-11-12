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
 *     sales or its refunds were not read in full, a figure is not a whole
 *     number of cents (or sales) at or above zero, an active campaign has no
 *     daily budget of its own (0), or no spend (or too little) was recorded.
 *     Then it says it is unknown, gives no figure and suggests nothing; an
 *     unknown is never read as zero.
 *   - Only a campaign the creator's limits cover (its platform and product
 *     approved, lib/ad-autopilot-rules.ts inScope) gets a change, as the
 *     autopilot touches no other.
 *   - A raise is prepared only for an active campaign that paid for itself
 *     and that the autopilot's own raise rule allows (raiseRefusal: judged,
 *     at least MIN_SALES_TO_RAISE sales, its cost per sale, spent so far over
 *     sales so far, at most RAISE_BELOW_PERCENT of the creator's most), and
 *     only as far as every limit the creator approved holds (withinLimits:
 *     daily budgets, the platforms' worst week and the worst total) and never
 *     by more than RAISE_PERCENT. Without approved limits nothing is raised.
 *   - At most one raise a day: a campaign whose budget was raised on its
 *     today (lastRaisedDay, kept by whoever applies the raise) gets none, so
 *     RAISE_PERCENT a day holds across recomputations. A day that cannot be
 *     read is unknown, never read as "never".
 *   - Every other campaign under the limits is read whole as well (a figure
 *     not whole and at or above zero, an unknown status or an id listed twice
 *     is unknown), so a bad figure elsewhere never makes room for a raise.
 *   - Cards shown together come from nextStepsFor: the best per sale first,
 *     each later raise counting the earlier ones as confirmed, so all of
 *     them confirmed still keep every limit (Claude 1's review on #3196).
 *   - A pause is prepared only for an active campaign that did not pay for
 *     itself once it spent JUDGE_AFTER_TIMES the creator's most per sale.
 *   - Every prepared change waits for the creator ("ask"): this rule changes
 *     nothing, calls nothing and spends nothing. It never promises what a
 *     change would bring; it says what was measured and what would change.
 *   - Before a raise is applied, confirmChange checks it again against the
 *     budgets of every campaign as the ad account has them at that moment:
 *     unchanged since the card, limits approved and in scope, the raise rule
 *     still met, not raised that day, at most RAISE_PERCENT, and every limit
 *     held with the others' live budgets. Otherwise it refuses and says why;
 *     nothing is changed.
 *
 * The sentences are in plain American English and pass the ad honesty check
 * (lib/ad-creative-check.ts): no promise of gain and no urgency
 * (tests/ad-next-step.test.ts).
 */
import { type AutopilotRules, type CampaignNow, type CampaignSetting, JUDGE_AFTER_TIMES, MIN_SALES_TO_RAISE, RAISE_BELOW_PERCENT, RAISE_PERCENT, checkRules, costPerSale, inScope, raiseRefusal, withinLimits } from "@/lib/ad-autopilot-rules";
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
  /**
   * The day its budget was last raised, as a day number like CampaignNow.today (the raisedOn that
   * confirmChange returned, kept by whoever applied it), or "never". Anything else is unknown.
   */
  lastRaisedDay: number | "never";
};

export type NextStepUnknown = "days" | "partial" | "sales" | "refunds" | "campaign" | "others" | "raised" | "budget" | "spend" | "little";

/** What the creator reads when a figure is unknown: no number, no suggestion. */
export const NEXT_STEP_UNKNOWN: Readonly<Record<NextStepUnknown, string>> = {
  days: "Unknown: these days could not be read, so no change is suggested.",
  partial: "Unknown: the numbers for these days are not complete, so no change is suggested.",
  sales: "Unknown: this campaign's sales were not fully read, so no change is suggested.",
  refunds: "Unknown: refunds were not fully read, so no change is suggested.",
  campaign: "Unknown: this campaign's figures from the ad account were not fully read, so no change is suggested.",
  others: "Unknown: the figures of your other campaigns were not fully read, so no change is suggested.",
  raised: "Unknown: the day its budget was last raised could not be read, so no change is suggested.",
  budget: "Unknown: this campaign has no daily budget of its own, so no change is suggested.",
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
/** A figure this rule reads: a whole number at or above zero; anything else is unknown, never a figure. */
const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const allWhole = (byDay: Readonly<Record<string, number>>) => Object.values(byDay).every(whole);
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** A campaign as read from the ad account: every figure whole and at or above zero, a known status. */
const readable = (c: CampaignNow) =>
  typeof c === "object" && c !== null && typeof c.id === "string" && (c.status === "ACTIVE" || c.status === "PAUSED") && whole(c.spentCents) && whole(c.dailyBudgetCents) && Number.isSafeInteger(c.daysLeft) && Number.isSafeInteger(c.today) && (c.sales === null || whole(c.sales));
/** Every campaign readable, and each listed once. */
const readableAll = (all: readonly CampaignNow[]) => Array.isArray(all) && all.every(readable) && new Set(all.map((x) => x.id)).size === all.length;
/** "never", or a whole day number no later than today. */
const readableDay = (day: unknown, today: number): day is number | "never" => day === "never" || (typeof day === "number" && Number.isSafeInteger(day) && day <= today);
/** The daily budget a campaign may spend: its own while active with days left, 0 otherwise. */
const liveDaily = (x: CampaignNow) => (x.status === "ACTIVE" && x.daysLeft > 0 ? x.dailyBudgetCents : 0);
/** The most a daily budget may become in one raise. */
const mostAfterRaise = (from: number) => Math.floor((from * (100 + RAISE_PERCENT)) / 100);

const OUT_OF_SCOPE = "Your ad limits do not include this ad platform or product, so no change is suggested.";
const NO_ROOM = "Your ad limits leave no room to raise its budget.";
const RAISED_TODAY = "Its budget was already raised today. A budget is raised at most once a day.";
const tooEarly = (amount: string) => `It is too early to judge: wait until it spends ${amount}.`;
const NONE_PENDING: ReadonlyMap<string, number> = new Map();

/** The next step for one campaign, with the other campaigns as they are; nothing is changed by it. */
export function nextStepFor(input: NextStepInput): NextStep {
  return stepWith(input, NONE_PENDING);
}

/**
 * The next steps for campaigns shown together, in the order given. Raises are worked out the best per sale
 * first (as autopilotChanges does), each counting the raises before it as confirmed, so confirming all of
 * them still keeps every limit. Nothing is changed by it.
 */
export function nextStepsFor(inputs: readonly NextStepInput[]): NextStep[] {
  const steps = inputs.map((input) => nextStepFor(input));
  const raises = inputs
    .map((input, i) => ({ input, i }))
    .filter(({ i }) => steps[i].change?.kind === "raise")
    .sort((a, b) => costPerSale(a.input.campaign) - costPerSale(b.input.campaign) || a.input.campaign.id.localeCompare(b.input.campaign.id) || a.i - b.i);
  const pending = new Map<string, number>();
  for (const { input, i } of raises) {
    steps[i] = stepWith(input, pending);
    const change = steps[i].change;
    if (change?.kind === "raise") pending.set(change.campaign, change.after.dailyBudgetCents);
  }
  return steps;
}

/** The live state confirmChange checks a change against, read from the ad account at the moment of confirming. */
export type ConfirmNow = {
  /** The limits the creator approved; null when none was chosen. */
  limits: AutopilotRules | null;
  /** Every campaign under those limits, as the ad account has them at this moment, the changed one included. */
  all: readonly CampaignNow[];
  /** The day the changed campaign's budget was last raised (a raisedOn kept earlier), or "never". */
  lastRaisedDay: number | "never";
};

export type ConfirmRefusal = "unknown" | "changed" | "rules" | "scope" | "rule" | "rate" | "step" | "limits";

/** What the creator reads when a confirmed change is not applied. */
export const CONFIRM_REFUSED: Readonly<Record<ConfirmRefusal, string>> = {
  unknown: "Unknown: your campaigns' budgets could not be read in full, so nothing was changed.",
  changed: "This campaign changed since this was suggested, so nothing was changed.",
  rules: "Choose your ad limits first, so any change stays inside them.",
  scope: "Your ad limits do not include this ad platform or product, so nothing was changed.",
  rule: "Its latest numbers no longer allow a raise, so nothing was changed.",
  rate: "Its budget was already raised today, so nothing was changed. A budget is raised at most once a day.",
  step: "This raise is larger than a budget may rise in one day, so nothing was changed.",
  limits: "With your other campaigns' budgets as they are, this raise would pass your ad limits, so nothing was changed.",
};

/**
 * Whether a prepared change may be applied, checked again against every campaign's live budget. A raise that
 * passes returns raisedOn, the day to keep as that campaign's lastRaisedDay; a pause only lowers spend. Pure:
 * it applies nothing.
 */
export function confirmChange(change: NextStepChange, now: ConfirmNow): { ok: true; raisedOn: number | null } | { ok: false; reason: ConfirmRefusal; message: string } {
  const refuse = (reason: ConfirmRefusal) => ({ ok: false as const, reason, message: CONFIRM_REFUSED[reason] });
  if (!readableAll(now.all)) return refuse("unknown");
  const c = now.all.find((x) => x.id === change.campaign);
  if (!c) return refuse("unknown");
  if (c.status !== change.before.status || c.dailyBudgetCents !== change.before.dailyBudgetCents) return refuse("changed");
  if (change.kind === "pause") return change.after.status === "PAUSED" && change.after.dailyBudgetCents === c.dailyBudgetCents ? { ok: true, raisedOn: null } : refuse("unknown");
  if (change.kind !== "raise" || change.after.status !== "ACTIVE") return refuse("unknown");
  if (c.status !== "ACTIVE" || !(c.daysLeft > 0)) return refuse("changed");
  if (!readableDay(now.lastRaisedDay, c.today)) return refuse("unknown");
  const rules = now.limits && checkRules(now.limits).ok ? now.limits : null;
  if (!rules) return refuse("rules");
  if (!inScope(rules, c)) return refuse("scope");
  if (raiseRefusal(c, rules) !== null) return refuse("rule");
  if (now.lastRaisedDay !== "never") return refuse("rate");
  const from = c.dailyBudgetCents;
  const to = change.after.dailyBudgetCents;
  if (!whole(to) || !(to > from) || to > mostAfterRaise(from) || !dailyBudgetAllowed(to)) return refuse("step");
  const daily = new Map(now.all.map((x) => [x.id, x.id === c.id ? to : liveDaily(x)] as const));
  if (!withinLimits(rules, now.all, daily)) return refuse("limits");
  return { ok: true, raisedOn: c.today };
}

/** One campaign's step, counting the raises already prepared beside it (pending) as confirmed. */
function stepWith(input: NextStepInput, pending: ReadonlyMap<string, number>): NextStep {
  const name = input.campaign.id;
  const unknown = (reason: NextStepUnknown): NextStep => ({ campaign: name, state: "unknown", unknown: reason, spentCents: null, backCents: null, days: null, says: NEXT_STEP_UNKNOWN[reason], note: null, ask: null, change: null });
  const span = daysBetween(input.from, input.to);
  if (!span || span > 400) return unknown("days");
  if (input.results.partial) return unknown("partial");
  const c = input.campaign;
  if (!input.results.salesKnown || input.salesByDay === null || !allWhole(input.salesByDay) || !whole(c.sales)) return unknown("sales");
  if (input.refundsByDay === null || !allWhole(input.refundsByDay)) return unknown("refunds");
  if (!whole(c.spentCents) || !whole(c.dailyBudgetCents) || !Number.isSafeInteger(c.daysLeft) || !Number.isSafeInteger(c.today)) return unknown("campaign");
  if (!readableAll(input.all)) return unknown("others");
  if (!readableDay(input.lastRaisedDay, c.today)) return unknown("raised");
  const active = c.status === "ACTIVE" && c.daysLeft > 0;
  if (active && c.dailyBudgetCents === 0) return unknown("budget");

  let spent = 0;
  let first = input.to;
  for (const entry of input.spends) {
    if (entry.campaign !== input.name) continue;
    if (!whole(entry.cents)) return unknown("spend");
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
  const rules = input.limits && checkRules(input.limits).ok ? input.limits : null;
  const facts = { campaign: name, unknown: null, spentCents: spent, backCents: back };

  if (paidAt !== null) {
    const says = `This campaign paid for itself in ${paidAt} ${paidAt === 1 ? "day" : "days"}: ${money(spent)} of ads, ${money(back)} back after refunds.`;
    const step = (note: string | null): NextStep => ({ ...facts, state: "paid_back", days: paidAt, says, note, ask: null, change: null });
    if (c.status !== "ACTIVE") return step("It is paused, so no change is suggested.");
    if (!active) return step(null);
    if (!rules) return step("Choose your ad limits first, so any change stays inside them.");
    if (!inScope(rules, c)) return step(OUT_OF_SCOPE);
    const refusal = raiseRefusal(c, rules);
    const sales = c.sales;
    const most = rules.maxCostPerSaleCents;
    if (refusal === "unmeasured") return unknown("sales");
    if (refusal === "early") return step(tooEarly(money(JUDGE_AFTER_TIMES * most)));
    if (refusal === "sales") return step(`It has ${sales} ${sales === 1 ? "sale" : "sales"} so far. A raise is suggested only once it has ${MIN_SALES_TO_RAISE}.`);
    if (refusal === "over") return step(`Each sale cost ${money(Math.ceil(costPerSale(c)))} in ads after refunds, above your most of ${money(most)}, so no raise is suggested.`);
    if (refusal === "margin") return step(`Each sale cost ${money(Math.ceil(costPerSale(c)))} in ads after refunds. A raise is suggested only at ${money(Math.floor((most * RAISE_BELOW_PERCENT) / 100))} or less.`);
    if (input.lastRaisedDay !== "never" && input.lastRaisedDay >= c.today) return step(RAISED_TODAY);
    if (pending.has(name)) return step(NO_ROOM);
    const from = c.dailyBudgetCents;
    const to = largestRaise(rules, input.all, c, pending);
    if (!dailyBudgetAllowed(from) || !(to > from) || to * 100 < from * 101) return step(NO_ROOM);
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
        what: `Its daily budget goes from ${money(from)} to ${money(to)} only after you confirm, and only if your limits still hold then. Nothing changes before that.`,
      },
    };
  }

  const says = `This campaign has not paid for itself yet: ${money(spent)} of ads, ${money(back)} back after refunds.`;
  const step = (note: string | null): NextStep => ({ ...facts, state: "not_paid_back", days: null, says, note, ask: null, change: null });
  if (!active || !rules) return step(null);
  if (!inScope(rules, c)) return step(OUT_OF_SCOPE);
  const judgeAt = JUDGE_AFTER_TIMES * rules.maxCostPerSaleCents;
  if (spent < judgeAt) return step(tooEarly(money(judgeAt)));
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

/**
 * The largest daily budget up to +RAISE_PERCENT that keeps every approved limit with the other campaigns as they
 * are, or at the budget a raise already prepared beside it (pending) would give them.
 */
function largestRaise(rules: AutopilotRules, all: readonly CampaignNow[], c: CampaignNow, pending: ReadonlyMap<string, number>): number {
  const list = [...all.filter((x) => x.id !== c.id), c];
  const daily = new Map(list.map((x) => [x.id, x.id === c.id ? liveDaily(x) : (pending.get(x.id) ?? liveDaily(x))] as const));
  const from = c.dailyBudgetCents;
  if (!withinLimits(rules, list, daily)) return from;
  let low = from;
  let high = mostAfterRaise(from);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    daily.set(c.id, mid);
    if (dailyBudgetAllowed(mid) && withinLimits(rules, list, daily)) low = mid;
    else high = mid - 1;
  }
  return low;
}
