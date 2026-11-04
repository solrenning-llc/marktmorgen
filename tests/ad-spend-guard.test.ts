/**
 * 632 [AA2] (e), unit 4: a budget change is a new plan inside the creator's
 * limit, PAUSED until confirmed again; the day's alert and the optional pause
 * at the limit (lib/ad-spend-guard.ts). Pure; no platform is called.
 */
import { activationAllowed, planCampaign, planHash } from "@/lib/ad-campaign-plan";
import { changeBudget, limitState } from "@/lib/ad-spend-guard";
import { done, is, part } from "./check";

const made = planCampaign({ platform: "meta", dailyBudgetCents: 2_000, start: "2026-11-01", end: "2026-11-30", creatorTotalLimitCents: 70_000, currency: "usd" });
if (!made.ok) throw new Error("no plan");
const plan = made.plan;

part("A budget change is a new plan, inside the limit");
// From Sunday 15 Nov: two full weeks (7 × 2,500 each) and 29–30 Nov (1.75 × 2 × 2,500).
const raised = changeBudget(plan, 2_500, 20_000, "2026-11-15");
is("made, with what was spent plus the worst case of the days left", raised.ok && raised.plan.maxSpendCents, 20_000 + 2 * 17_500 + 8_750);
is("it comes back PAUSED", raised.ok && raised.plan.status, "PAUSED");
is("the old confirmation does not activate it", raised.ok && activationAllowed(raised.plan, { planHash: planHash(plan), shownMaxCents: plan.maxSpendCents }), false);
is("its own confirmation does", raised.ok && activationAllowed(raised.plan, { planHash: planHash(raised.plan), shownMaxCents: raised.plan.maxSpendCents }), true);
is("too high for the limit: refused", (changeBudget(plan, 4_000, 30_000, "2026-11-15") as { error?: string }).error, "over_limit");
is("after the last day: refused", (changeBudget(plan, 2_000, 60_000, "2026-12-01") as { error?: string }).error, "ended");
is("spend not read: refused, never guessed", (changeBudget(plan, 2_000, Number.NaN, "2026-11-15") as { error?: string }).error, "spent");
is("zero budget: refused", (changeBudget(plan, 0, 30_000, "2026-11-15") as { error?: string }).error, "budget");
is("before the start counts from the start", changeBudget(plan, 2_000, 0, "2026-10-20").ok && (changeBudget(plan, 2_000, 0, "2026-10-20") as { plan: { maxSpendCents: number } }).plan.maxSpendCents, plan.maxSpendCents);

part("The day's alert and the optional pause");
const base = { spentTotalCents: 10_000, spentTodayCents: 2_500, creatorTotalLimitCents: 70_000, dayAlertCents: 2_000, autoPause: true };
is("today past the chosen amount: alert", limitState(base).alertToday, true);
is("no amount chosen: no alert", limitState({ ...base, dayAlertCents: null }).alertToday, false);
is("under the limit: no pause", limitState(base).pauseNow, false);
is("at the limit with the pause chosen: pause", limitState({ ...base, spentTotalCents: 70_000 }).pauseNow, true);
is("at the limit without the pause chosen: no pause, the plan's own ceiling holds", limitState({ ...base, spentTotalCents: 70_000, autoPause: false }).pauseNow, false);

done();
