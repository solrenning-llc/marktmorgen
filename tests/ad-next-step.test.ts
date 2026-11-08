/**
 * 632 [AA2] (o): the next step for one ad campaign, from the store's own
 * measured numbers. A measured payback may offer a budget raise inside the
 * creator's limits, never past them; an unmeasured or partial figure is
 * unknown, never zero and never a suggestion; refunds take sales back; every
 * change only waits for the creator's confirmation; every sentence passes the
 * ad honesty check (no promise of gain, no urgency) in plain American English.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextStepFor, NEXT_STEP_UNKNOWN, type NextStep, type NextStepInput } from "@/lib/ad-next-step";
import { MIN_SALES_TO_RAISE, RAISE_PERCENT, withinLimits, type AutopilotRules, type CampaignNow } from "@/lib/ad-autopilot-rules";
import { checkAdText } from "@/lib/ad-creative-check";
import { britishCopyHits } from "./us-english-source";
import { done, is, part } from "./check";

const TODAY = Date.UTC(2026, 10, 2) / 86_400_000; // Monday, 2 November 2026
const limits: AutopilotRules = { mode: "approve", maxDailyCents: 50_000, maxWeekCents: 400_000, maxTotalCents: 5_000_000, maxCostPerSaleCents: 10_000, platforms: ["meta", "google"], products: ["p1"] };
const camp = (extra: Partial<CampaignNow> = {}): CampaignNow => ({ id: "c1", platform: "meta", product: "p1", status: "ACTIVE", dailyBudgetCents: 5_000, spentCents: 20_000, sales: 5, today: TODAY, daysLeft: 30, ...extra });
/** $200 of ads on the campaign "spring", spread over 20–29 October. */
const spends = [{ id: "s1", channel: "instagram", campaign: "spring", cents: 20_000, from: "2026-10-20", to: "2026-10-29", source: "meta" as const }];
/** $210 of sales by 23 October, the fourth day counting the first day of spend. */
const sales = { "2026-10-21": 6_000, "2026-10-22": 6_000, "2026-10-23": 9_000 };
const base = (extra: Partial<NextStepInput> = {}): NextStepInput => ({
  name: "spring",
  campaign: camp(),
  currency: "usd",
  from: "2026-10-20",
  to: "2026-11-02",
  results: { partial: false, salesKnown: true },
  spends,
  salesByDay: sales,
  refundsByDay: {},
  limits,
  all: [camp()],
  ...extra,
});
const words = (s: NextStep) => [s.says, s.note, s.ask, s.change?.what].filter((w): w is string => Boolean(w));

part("Paid for itself in N days");
const paid = nextStepFor(base());
is("the state and the days it took", [paid.state, paid.days], ["paid_back", 4]);
is("spent and back after refunds, as measured", [paid.spentCents, paid.backCents], [20_000, 21_000]);
is("the sentence says the days and the money", paid.says, "This campaign paid for itself in 4 days: $200.00 of ads, $210.00 back after refunds.");
is("the prepared change raises the daily budget by the most a day allows", [paid.change?.kind, paid.change?.before.dailyBudgetCents, paid.change?.after.dailyBudgetCents, paid.change?.after.status], ["raise", 5_000, 5_000 * (100 + RAISE_PERCENT) / 100, "ACTIVE"]);
is("the question names the change and asks for it", paid.ask, `Raise its daily budget by ${RAISE_PERCENT}%, from $50.00 to $60.00, within your limits?`);
is("the change only waits for the creator", paid.change?.apply, "ask");
is("the change says what changes and that it waits", paid.change?.what, "Its daily budget goes from $50.00 to $60.00 only after you confirm. Nothing changes before that.");
is("one day of payback reads as a day", nextStepFor(base({ salesByDay: { "2026-10-20": 25_000 } })).says.startsWith("This campaign paid for itself in 1 day:"), true);
is("another currency is written as that currency", nextStepFor(base({ currency: "eur" })).says, "This campaign paid for itself in 4 days: €200.00 of ads, €210.00 back after refunds.");
is("the same numbers give the same step", JSON.stringify(nextStepFor(base())), JSON.stringify(paid));

part("Never past the creator's limits");
const tightDay = nextStepFor(base({ limits: { ...limits, maxDailyCents: 5_500 } }));
is("a daily limit lowers the raise to what fits", [tightDay.change?.after.dailyBudgetCents, tightDay.ask], [5_500, "Raise its daily budget by 10%, from $50.00 to $55.00, within your limits?"]);
const full = nextStepFor(base({ limits: { ...limits, maxDailyCents: 5_000 } }));
is("no room: no change, and the note says why", [full.state, full.change, full.ask, full.note], ["paid_back", null, null, "Your ad limits leave no room to raise its budget."]);
const wide = { ...limits, maxWeekCents: 1_000_000 };
const shared = nextStepFor(base({ limits: wide, all: [camp(), camp({ id: "c2", dailyBudgetCents: 44_000 })] }));
is("other campaigns under the same limits take their share", shared.change?.after.dailyBudgetCents, 6_000);
const crowded = nextStepFor(base({ limits: wide, all: [camp(), camp({ id: "c2", dailyBudgetCents: 45_000 })] }));
is("when the others fill the limit, nothing is raised", crowded.change, null);
is("the week's worst case is a limit too", nextStepFor(base({ limits: { ...limits, maxWeekCents: 35_000 } })).change, null);
is("the total's worst case is a limit too", nextStepFor(base({ limits: { ...limits, maxTotalCents: 20_000 + 150_000 } })).change, null);
let past = 0;
for (const day of [5_000, 5_100, 5_499, 5_500, 5_999, 6_000, 9_000, 49_000]) {
  for (const week of [30_000, 36_000, 42_000, 400_000]) {
    const r = { ...limits, maxDailyCents: day, maxWeekCents: week };
    const s = nextStepFor(base({ limits: r }));
    if (!s.change) continue;
    const others = new Map([["c1", s.change.after.dailyBudgetCents]]);
    if (!withinLimits(r, [camp()], others) || s.change.after.dailyBudgetCents > 6_000) past += 1;
  }
}
is("no prepared raise ever passes a limit or the most a day allows", past, 0);
const none = nextStepFor(base({ limits: null }));
is("without limits chosen, no raise is prepared", [none.state, none.change, none.note], ["paid_back", null, "Choose your ad limits first, so any change stays inside them."]);
is("limits that cannot be approved prepare nothing", nextStepFor(base({ limits: { ...limits, maxTotalCents: 0 } })).change, null);
is("a cost per sale above the creator's most prepares no raise", nextStepFor(base({ limits: { ...limits, maxCostPerSaleCents: 3_000 } })).change, null);
is("too few sales prepare no raise", [nextStepFor(base({ campaign: camp({ sales: MIN_SALES_TO_RAISE - 1 }) })).change, nextStepFor(base({ campaign: camp({ sales: MIN_SALES_TO_RAISE - 1 }) })).note], [null, `It has ${MIN_SALES_TO_RAISE - 1} sales so far. A raise is suggested only once it has ${MIN_SALES_TO_RAISE}.`]);
is("a paused campaign is never switched on", [nextStepFor(base({ campaign: camp({ status: "PAUSED" }) })).change, nextStepFor(base({ campaign: camp({ status: "PAUSED" }) })).note], [null, "It is paused, so no change is suggested."]);
is("an ended campaign prepares nothing", nextStepFor(base({ campaign: camp({ daysLeft: 0 }) })).change, null);

part("Not paid for itself");
const notYet = nextStepFor(base({ salesByDay: { "2026-10-22": 5_000 } }));
is("the state, no days, the money as measured", [notYet.state, notYet.days, notYet.spentCents, notYet.backCents], ["not_paid_back", null, 20_000, 5_000]);
is("the sentence says it has not paid for itself", notYet.says, "This campaign has not paid for itself yet: $200.00 of ads, $50.00 back after refunds.");
is("measured enough: a pause is prepared, never made", [notYet.change?.kind, notYet.change?.after.status, notYet.change?.after.dailyBudgetCents, notYet.change?.apply], ["pause", "PAUSED", 5_000, "ask"]);
is("the pause question", notYet.ask, "Pause this campaign?");
is("the pause says what changes and that it waits", notYet.change?.what, "It stops showing only after you confirm. Its daily budget stays at $50.00, and you can switch it back on.");
const early = nextStepFor(base({ salesByDay: { "2026-10-22": 5_000 }, limits: { ...limits, maxCostPerSaleCents: 15_000 } }));
is("too early to judge: no pause, and the note says why", [early.state, early.change, early.note], ["not_paid_back", null, "It is too early to judge: wait until it spends $300.00."]);
is("no limits: no pause prepared", nextStepFor(base({ salesByDay: {}, limits: null })).change, null);
is("no sale at all is a measured zero, said as such", nextStepFor(base({ salesByDay: {}, campaign: camp({ sales: 0 }) })).backCents, 0);
is("a paused one is not paused again", nextStepFor(base({ salesByDay: {}, campaign: camp({ status: "PAUSED" }) })).change, null);

part("Refunds take sales back");
const refunded = nextStepFor(base({ refundsByDay: { "2026-10-25": 6_000 } }));
is("a refund after the payback undoes it", [refunded.state, refunded.days, refunded.backCents, refunded.change?.kind], ["not_paid_back", null, 15_000, "pause"]);
const again = nextStepFor(base({ refundsByDay: { "2026-10-25": 6_000 }, salesByDay: { ...sales, "2026-10-28": 8_000 } }));
is("paid back once more counts from the day it held", [again.state, again.days, again.backCents], ["paid_back", 9, 23_000]);
is("a refund on the same day counts that day", nextStepFor(base({ refundsByDay: { "2026-10-23": 1_001 } })).state, "not_paid_back");
is("refunds of sales before the first day of ads are not counted", nextStepFor(base({ refundsByDay: { "2026-10-19": 50_000 } })).days, 4);

part("Unknown or partial: unknown, never zero, never a suggestion");
const unknowns: [string, Partial<NextStepInput>, keyof typeof NEXT_STEP_UNKNOWN][] = [
  ["the numbers are partial", { results: { partial: true, salesKnown: true } }, "partial"],
  ["the store's sales were not read", { results: { partial: false, salesKnown: false } }, "sales"],
  ["the campaign's sales by day were not measured", { salesByDay: null }, "sales"],
  ["its sales after refunds were not measured", { campaign: camp({ sales: null }) }, "sales"],
  ["refunds were not read", { refundsByDay: null }, "refunds"],
  ["no ad spend was recorded for it", { spends: [] }, "spend"],
  ["spend of another campaign does not count", { spends: [{ ...spends[0], campaign: "autumn" }] }, "spend"],
  ["too little was spent to say", { spends: [{ ...spends[0], cents: 900 }] }, "little"],
  ["the days are not real", { from: "2026-11-31", to: "2026-11-02" }, "days"],
];
for (const [what, extra, reason] of unknowns) {
  const s = nextStepFor(base(extra));
  is(`${what}: unknown, with its reason, no figure and no step`, [s.state, s.unknown, s.spentCents, s.backCents, s.days, s.change, s.ask], ["unknown", reason, null, null, null, null, null]);
  is(`${what}: says it is unknown, never $0`, [s.says === NEXT_STEP_UNKNOWN[reason], /\$0\b|\$0\.00/.test(words(s).join(" "))], [true, false]);
}
is("a partial read stays unknown even when the money would have paid back", nextStepFor(base({ results: { partial: true, salesKnown: true }, salesByDay: { "2026-10-20": 90_000 } })).state, "unknown");

part("The words pass the ad honesty check and read simply");
const scenarios: NextStep[] = [paid, tightDay, full, none, notYet, early, refunded, again,
  nextStepFor(base({ campaign: camp({ sales: 1 }) })), nextStepFor(base({ campaign: camp({ status: "PAUSED" }) })),
  ...unknowns.map(([, extra]) => nextStepFor(base(extra))), ...Object.values(NEXT_STEP_UNKNOWN).map((says) => ({ ...paid, says, note: null, ask: null, change: null }))];
const all = [...new Set(scenarios.flatMap(words))];
is("there are sentences to check", all.length > 15, true);
const context = { priceCents: null, currency: "usd", ownHosts: [], realDeadline: false, realStockLimit: false, verifiedReviews: [] };
const refused = all.filter((text) => { const c = checkAdText({ headline: "", text, description: "", button: "" }, context); return !c.sendable || c.warnings.length > 0; });
is("every sentence is sendable with no warning: no promise of gain, no urgency", refused, []);
is("no promise of gain in any sentence", all.filter((t) => /\b(?:guarantee\w*|will (?:earn|make|bring|get|sell)|more (?:sales|money|profit)|profit\w*|grow\w*|boost\w*|win|wins|winning)\b/i.test(t)), []);
is("no urgency in any sentence", all.filter((t) => /\b(now|hurry|today only|last chance|limited|don't miss|before it's too late)\b/i.test(t)), []);
is("no jargon in any sentence", all.filter((t) => /\b(ROAS|ROI|CPA|CPC|CTR|KPI|ROI|attribution|optimi[sz]e)\b/i.test(t)), []);
is("short sentences: at most 20 words each", all.flatMap((t) => t.split(/(?<=[.?:])\s+/)).filter((s) => s.split(/\s+/).length > 20), []);
is("American English in every sentence", all.flatMap((t) => britishCopyHits("lib/sample.ts", `const words=${JSON.stringify(t)};`)), []);
const source = readFileSync(join(process.cwd(), "lib/ad-next-step.ts"), "utf8");
is("American English in the module", britishCopyHits("lib/ad-next-step.ts", source), []);

part("A pure rule: nothing is changed, called or spent");
is("no network, store or spending in the module", source.match(/\bfetch\(|redis|@\/lib\/(kv|redis|meta-ads|store-data)\b|process\.env|setTimeout/g), null);
is("every change it prepares waits for the creator", scenarios.filter((s) => s.change && s.change.apply !== "ask"), []);
is("the input campaign is never changed", (() => { const c = camp(); const i = base({ campaign: c, all: [c] }); nextStepFor(i); return [c.status, c.dailyBudgetCents]; })(), ["ACTIVE", 5_000]);

done();
