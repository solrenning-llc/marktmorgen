/**
 * 632 [AA2] (h), unit 5: the ads autopilot never passes the creator's
 * limits, judges a campaign only once measured enough, never reads an
 * unknown as no sale, and never touches a campaign outside what it may.
 */
import { AUTOPILOT_KIND, JUDGE_AFTER_TIMES, RAISE_PERCENT, autopilotChanges, checkRules, type AdPlatform, type AutopilotRules, type CampaignNow } from "@/lib/ad-autopilot-rules";
import { done, is, part } from "./check";

const TODAY = Date.UTC(2026, 10, 2) / 86_400_000; // a Monday
const rules: AutopilotRules = { mode: "approve", maxDailyCents: 50_000, maxWeekCents: 400_000, maxTotalCents: 5_000_000, maxCostPerSaleCents: 2_000, platforms: ["meta", "google"], products: ["p1", "p2"] };
const camp = (id: string, extra: Partial<CampaignNow> = {}): CampaignNow => ({ id, platform: "meta", product: "p1", status: "ACTIVE", dailyBudgetCents: 5_000, spentCents: 0, sales: 0, today: TODAY, daysLeft: 30, ...extra });
const only = (c: CampaignNow, r = rules) => autopilotChanges(r, [c]);
/** Each campaign's daily budget once the changes are made (0 when paused). */
const afterOf = (changes: ReturnType<typeof autopilotChanges>, list: readonly CampaignNow[]) =>
  new Map(list.map((c) => {
    const s = changes.find((x) => x.campaign === c.id)?.after ?? c;
    return [c.id, s.status === "ACTIVE" ? s.dailyBudgetCents : 0] as const;
  }));

/**
 * Independent test oracle for the platform ceilings. Do not call production
 * withinLimits() or worstCaseCents() here: this check must catch a shared
 * calculation bug in both the planner and its production helper.
 */
function referenceWorstCase(platform: AdPlatform, dailyCents: number, first: number, days: number): number {
  if (platform === "meta" && days < 7) return dailyCents * days;
  const periods = new Map<string, number>();
  for (let offset = 0; offset < days; offset += 1) {
    const dayNumber = first + offset;
    const date = new Date(dayNumber * 86_400_000);
    const key = platform === "google"
      ? date.toISOString().slice(0, 7)
      : String(dayNumber - date.getUTCDay());
    periods.set(key, (periods.get(key) ?? 0) + 1);
  }
  let total = 0;
  for (const daysInPeriod of periods.values()) {
    const dailyNumerator = platform === "meta" ? 7 : platform === "google" ? 2 : 5;
    const dailyDenominator = platform === "meta" || platform === "tiktok" ? 4 : 1;
    const perDayCeiling = Math.ceil((dailyCents * dailyNumerator * daysInPeriod) / dailyDenominator);
    const periodCeiling = platform === "google" ? Math.ceil((dailyCents * 152) / 5) : dailyCents * 7;
    total += Math.min(perDayCeiling, periodCeiling);
  }
  return total;
}

function referenceWithinLimits(r: AutopilotRules, campaigns: readonly CampaignNow[], daily: ReadonlyMap<string, number>): boolean {
  let day = 0;
  let week = 0;
  let total = 0;
  for (const campaign of campaigns) {
    const budget = daily.get(campaign.id) ?? 0;
    day += budget;
    week += referenceWorstCase(campaign.platform, budget, campaign.today, Math.min(7, Math.max(0, campaign.daysLeft)));
    total += campaign.spentCents + referenceWorstCase(campaign.platform, budget, campaign.today, Math.max(0, campaign.daysLeft));
  }
  return day <= r.maxDailyCents && week <= r.maxWeekCents && total <= r.maxTotalCents;
}

part("Approving the limits");
is("a complete set is accepted", checkRules(rules).ok, true);
is("each missing limit is refused with its reason", [
  checkRules({ ...rules, mode: "yolo" as never }),
  checkRules({ ...rules, maxDailyCents: 0 }),
  checkRules({ ...rules, maxWeekCents: 1.5 }),
  checkRules({ ...rules, maxTotalCents: -1 }),
  checkRules({ ...rules, maxCostPerSaleCents: 0 }),
  checkRules({ ...rules, platforms: [] }),
  checkRules({ ...rules, products: [] }),
].map((r) => (r.ok ? "ok" : r.error)), ["mode", "daily", "week", "total", "cost", "scope", "scope"]);
is("limits that are not approvable change nothing", autopilotChanges({ ...rules, maxTotalCents: 0 }, [camp("a", { spentCents: 100_000, sales: 0 })]), []);
is("a change reaches money: one at a time, with undo", [AUTOPILOT_KIND.scope, AUTOPILOT_KIND.undo], ["execute", true]);

part("Only its own campaigns");
is("another network is left as it is", only(camp("x", { platform: "tiktok", spentCents: 100_000, sales: 0 })), []);
is("another product is left as it is", only(camp("x", { product: "p9", spentCents: 100_000, sales: 0 })), []);
is("a campaign that ended is left as it is", only(camp("x", { daysLeft: 0, spentCents: 100_000, sales: 0 })), []);
is("a campaign the creator paused is never switched on", only(camp("x", { status: "PAUSED", spentCents: 100_000, sales: 50 })), []);

part("Judged only once measured");
is("too little spent to say: held", only(camp("a", { spentCents: JUDGE_AFTER_TIMES * 2_000 - 1, sales: 0 })), []);
is("sales not measured: held, never read as none", only(camp("a", { spentCents: 1_000_000, sales: null })), []);

part("Paused when it does not pay for itself");
const lost = only(camp("a", { spentCents: 4_000, sales: 0 }));
is("no sale after twice the most a sale may cost: paused", lost.map((c) => [c.kind, c.after.status, c.after.dailyBudgetCents]), [["pause", "PAUSED", 5_000]]);
is("it says why, in plain words", lost[0].why, "It spent $40.00 with no sale after refunds.");
const dear = only(camp("a", { spentCents: 30_000, sales: 10 }));
is("each sale above the most: paused, with the cost said", [dear[0].kind, dear[0].why], ["pause", "Each sale cost $30.00 in ads after refunds, above your most of $20.00."]);
is("at exactly the most a sale may cost: kept", only(camp("a", { spentCents: 20_000, sales: 10 })), []);

part("Raised when it pays for itself, never past a limit");
const good = only(camp("a", { spentCents: 10_000, sales: 10 }));
is(`cheap sales: raised by ${RAISE_PERCENT}% at most`, good.map((c) => [c.kind, c.before.dailyBudgetCents, c.after.dailyBudgetCents]), [["raise", 5_000, 6_000]]);
is("too few sales to raise", only(camp("a", { spentCents: 4_000, sales: 2 })), []);
is("cheap, but not cheap enough to raise (over 70% of the most)", only(camp("a", { spentCents: 15_000, sales: 10 })), []);
is("the daily limit caps the raise", only(camp("a", { spentCents: 10_000, sales: 10 }), { ...rules, maxDailyCents: 5_500 })[0].after.dailyBudgetCents, 5_500);
// From a Monday the next seven days cross two Sunday-to-Saturday weeks: 7 × daily, then 1.75 × daily.
is("the week's worst caps it (Meta: 8.75 × daily from a Monday)", only(camp("a", { spentCents: 10_000, sales: 10 }), { ...rules, maxWeekCents: 48_125 })[0].after.dailyBudgetCents, 5_500);
// Ten days from a Monday: 6 days of one week (7 × daily) and 4 of the next (7 × daily).
const totalCapped = only(camp("a", { spentCents: 10_000, sales: 10, daysLeft: 10 }), { ...rules, maxTotalCents: 10_000 + 14 * 5_500 });
is("the total's worst caps it (spent + the remaining days' worst)", totalCapped[0].after.dailyBudgetCents, 5_500);
is("at a limit already: no raise", only(camp("a", { spentCents: 10_000, sales: 10 }), { ...rules, maxDailyCents: 5_000 }), []);
const two = autopilotChanges({ ...rules, maxDailyCents: 11_000 }, [camp("a", { spentCents: 10_000, sales: 10 }), camp("b", { spentCents: 6_000, sales: 10 })]);
is("the best per sale is raised first", two.map((c) => [c.campaign, c.after.dailyBudgetCents]), [["b", 6_000]]);

part("Brought back inside when today's budgets pass a limit");
const over = autopilotChanges({ ...rules, maxDailyCents: 8_000 }, [camp("cheap", { spentCents: 1_000, sales: 1 }), camp("dear", { spentCents: 1_900, sales: 1 })]);
is("the dearest per sale gives way first", over.map((c) => [c.campaign, c.kind, c.after.dailyBudgetCents]), [["dear", "lower", 2_500]]);
const pair = [camp("a", { spentCents: 1_000, sales: 1 }), camp("b", { spentCents: 1_500, sales: 1 })];
const tight = autopilotChanges({ ...rules, maxDailyCents: 1_000 }, pair);
is("lowered, then paused, until the limit holds", referenceWithinLimits({ ...rules, maxDailyCents: 1_000 }, pair, afterOf(tight, pair)), true);

part("Approve each change, or carry out within the limits");
is("approve mode: every change waits for the creator", lost[0].apply, "ask");
is("auto mode: carried out inside the limits", only(camp("a", { spentCents: 4_000, sales: 0 }), { ...rules, mode: "auto" })[0].apply, "now");
is("every change keeps its before for undo", good[0].before, { status: "ACTIVE", dailyBudgetCents: 5_000 });

part("Never past a limit, whatever the campaigns (random cases)");
let seed = 7;
const rand = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648), seed % n);
let broken = 0;
let raisedTooMuch = 0;
let foreign = 0;
for (let round = 0; round < 400; round += 1) {
  const r: AutopilotRules = { ...rules, maxDailyCents: 1_000 + rand(60_000), maxWeekCents: 5_000 + rand(400_000), maxTotalCents: 20_000 + rand(2_000_000), maxCostPerSaleCents: 500 + rand(5_000) };
  const list: CampaignNow[] = Array.from({ length: 1 + rand(6) }, (_, i) => camp(`c${i}`, {
    platform: (["meta", "google", "tiktok"] as const)[rand(3)],
    product: ["p1", "p2", "p9"][rand(3)],
    status: rand(5) ? "ACTIVE" : "PAUSED",
    dailyBudgetCents: 100 + rand(20_000),
    spentCents: rand(50_000),
    sales: rand(6) ? rand(20) : null,
    daysLeft: rand(40),
  }));
  const changes = autopilotChanges(r, list);
  const own = list.filter((c) => r.platforms.includes(c.platform) && r.products.includes(c.product) && c.daysLeft > 0);
  if (changes.some((c) => !own.some((o) => o.id === c.campaign))) foreign += 1;
  if (changes.some((c) => c.kind === "raise" && c.after.dailyBudgetCents > Math.floor((c.before.dailyBudgetCents * (100 + RAISE_PERCENT)) / 100))) raisedTooMuch += 1;
  const after = afterOf(changes, own);
  const allPaused = [...after.values()].every((d) => d === 0);
  if (!referenceWithinLimits(r, own, after) && !allPaused) broken += 1;
}
is("after its changes every limit holds (or all its campaigns are paused)", broken, 0);
is("no raise above the step", raisedTooMuch, 0);
is("no change to a campaign it does not own", foreign, 0);

done();
