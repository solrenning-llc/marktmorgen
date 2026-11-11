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
import * as next from "@/lib/ad-next-step";
import { nextStepFor, NEXT_STEP_UNKNOWN, type NextStep, type NextStepChange, type NextStepInput } from "@/lib/ad-next-step";
import { MIN_SALES_TO_RAISE, RAISE_PERCENT, autopilotChanges, withinLimits, type AutopilotRules, type CampaignNow } from "@/lib/ad-autopilot-rules";
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
  lastRaisedDay: "never",
  ...extra,
});
const words = (s: NextStep) => [s.says, s.note, s.ask, s.change?.what].filter((w): w is string => Boolean(w));

part("Paid for itself in N days");
const paid = nextStepFor(base());
is("the state and the days it took", [paid.state, paid.days], ["paid_back", 4]);
is("spent and back after refunds, as measured", [paid.spentCents, paid.backCents], [20_000, 21_000]);
is("the sentence says the days and the money", paid.says, "This campaign paid for itself in 4 days: $200 of ads, $210 back after refunds.");
is("the prepared change raises the daily budget by the most a day allows", [paid.change?.kind, paid.change?.before.dailyBudgetCents, paid.change?.after.dailyBudgetCents, paid.change?.after.status], ["raise", 5_000, 5_000 * (100 + RAISE_PERCENT) / 100, "ACTIVE"]);
is("the question names the change and asks for it", paid.ask, `Raise its daily budget by ${RAISE_PERCENT}%, from $50 to $60, within your limits?`);
is("the change only waits for the creator", paid.change?.apply, "ask");
is("the change says what changes and that it waits", paid.change?.what, "Its daily budget goes from $50 to $60 only after you confirm, and only if your limits still hold then. Nothing changes before that.");
is("one day of payback reads as a day", nextStepFor(base({ salesByDay: { "2026-10-20": 25_000 } })).says.startsWith("This campaign paid for itself in 1 day:"), true);
is("another currency is written as that currency", nextStepFor(base({ currency: "eur" })).says, "This campaign paid for itself in 4 days: €200 of ads, €210 back after refunds.");
is("the same numbers give the same step", JSON.stringify(nextStepFor(base())), JSON.stringify(paid));

part("Never past the creator's limits");
const tightDay = nextStepFor(base({ limits: { ...limits, maxDailyCents: 5_500 } }));
is("a daily limit lowers the raise to what fits", [tightDay.change?.after.dailyBudgetCents, tightDay.ask], [5_500, "Raise its daily budget by 10%, from $50 to $55, within your limits?"]);
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
    if (s.change.after.dailyBudgetCents > day || s.change.after.dailyBudgetCents > 6_000) past += 1;
  }
}
is("no prepared raise exceeds the daily limit or the most a day allows", past, 0);
const none = nextStepFor(base({ limits: null }));
is("without limits chosen, no raise is prepared", [none.state, none.change, none.note], ["paid_back", null, "Choose your ad limits first, so any change stays inside them."]);
is("limits that cannot be approved prepare nothing", nextStepFor(base({ limits: { ...limits, maxTotalCents: 0 } })).change, null);
is("a cost per sale above the creator's most prepares no raise", nextStepFor(base({ limits: { ...limits, maxCostPerSaleCents: 3_000 } })).change, null);
is("too few sales prepare no raise", [nextStepFor(base({ campaign: camp({ sales: MIN_SALES_TO_RAISE - 1 }) })).change, nextStepFor(base({ campaign: camp({ sales: MIN_SALES_TO_RAISE - 1 }) })).note], [null, `It has ${MIN_SALES_TO_RAISE - 1} sales so far. A raise is suggested only once it has ${MIN_SALES_TO_RAISE}.`]);
is("a paused campaign is never switched on", [nextStepFor(base({ campaign: camp({ status: "PAUSED" }) })).change, nextStepFor(base({ campaign: camp({ status: "PAUSED" }) })).note], [null, "It is paused, so no change is suggested."]);
is("an ended campaign prepares nothing", nextStepFor(base({ campaign: camp({ daysLeft: 0 }) })).change, null);

part("A raise only where the autopilot would raise: cost per sale over the same period, under 70% of the most");
// Claude 4's probe on #3196: the spend of the days shown was divided by the sales of the campaign's whole life.
const dear = camp({ spentCents: 60_000, sales: 5 });
const over = nextStepFor(base({ campaign: dear, all: [dear] }));
is("a cost per sale above the creator's most ($120 > $100) prepares no raise, and says why", [over.change, over.ask, over.note], [null, null, "Each sale cost $120 in ads after refunds, above your most of $100, so no raise is suggested."]);
const near = camp({ spentCents: 40_000, sales: 5 });
const margin = nextStepFor(base({ campaign: near, all: [near] }));
is("a cost per sale under the most but above 70% of it ($80) prepares no raise, as the autopilot", [margin.change, margin.note], [null, "Each sale cost $80 in ads after refunds. A raise is suggested only at $70 or less."]);
const young = camp({ spentCents: 10_000, sales: 5 });
const tooEarly = nextStepFor(base({ campaign: young, all: [young] }));
is("a campaign not yet judged by the autopilot prepares no raise", [tooEarly.change, tooEarly.note], [null, "It is too early to judge: wait until it spends $200."]);
const disagree: string[] = [];
for (const spentCents of [10_000, 19_999, 20_000, 28_000, 35_000, 35_001, 40_000, 50_000, 50_001, 60_000]) {
  for (const n of [2, 3, 5, 10]) {
    const c = camp({ spentCents, sales: n });
    const mine = nextStepFor(base({ campaign: c, all: [c] })).change;
    const pilot = autopilotChanges(limits, [c]).find((x) => x.kind === "raise");
    if (JSON.stringify(mine?.kind === "raise" ? mine.after : null) !== JSON.stringify(pilot?.after ?? null)) disagree.push(`${spentCents}/${n}`);
  }
}
is("for every cost per sale, a raise is prepared exactly when the autopilot raises, to the same budget", disagree, []);

part("Only campaigns the creator's limits cover");
const tiktok = camp({ platform: "tiktok" });
const otherNet = nextStepFor(base({ campaign: tiktok, all: [tiktok] }));
is("a network the creator did not approve: no raise, and the note says why", [otherNet.change, otherNet.ask, otherNet.note], [null, null, "Your ad limits do not include this ad platform or product, so no change is suggested."]);
const p9 = camp({ product: "p9" });
const otherProduct = nextStepFor(base({ campaign: p9, all: [p9] }));
is("a product the creator did not approve: no raise", [otherProduct.change, otherProduct.note], [null, "Your ad limits do not include this ad platform or product, so no change is suggested."]);
const outPause = nextStepFor(base({ campaign: tiktok, all: [tiktok], salesByDay: { "2026-10-22": 5_000 } }));
is("a network the creator did not approve: no pause either, as the autopilot leaves it alone", [outPause.state, outPause.change, outPause.ask], ["not_paid_back", null, null]);

part("Not paid for itself");
const notYet = nextStepFor(base({ salesByDay: { "2026-10-22": 5_000 } }));
is("the state, no days, the money as measured", [notYet.state, notYet.days, notYet.spentCents, notYet.backCents], ["not_paid_back", null, 20_000, 5_000]);
is("the sentence says it has not paid for itself", notYet.says, "This campaign has not paid for itself yet: $200 of ads, $50 back after refunds.");
is("measured enough: a pause is prepared, never made", [notYet.change?.kind, notYet.change?.after.status, notYet.change?.after.dailyBudgetCents, notYet.change?.apply], ["pause", "PAUSED", 5_000, "ask"]);
is("the pause question", notYet.ask, "Pause this campaign?");
is("the pause says what changes and that it waits", notYet.change?.what, "It stops showing only after you confirm. Its daily budget stays at $50, and you can switch it back on.");
const early = nextStepFor(base({ salesByDay: { "2026-10-22": 5_000 }, limits: { ...limits, maxCostPerSaleCents: 15_000 } }));
is("too early to judge: no pause, and the note says why", [early.state, early.change, early.note], ["not_paid_back", null, "It is too early to judge: wait until it spends $300."]);
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

part("Two cards shown together never add up past the daily cap (Claude 1's review on #3196, MÉDIO 1)");
// Daily limit $110, A and B at $50 a day, both paid back: each card alone offered $50 to $60, together $120.
const pair = { ...limits, maxDailyCents: 11_000 };
const campA = camp({ id: "a" });
const campB = camp({ id: "b" });
const cardFor = (c: CampaignNow) => base({ campaign: c, all: [campA, campB], limits: pair });
const attempt = <T,>(f: () => T): T | string => { try { return f(); } catch (e) { return `throws: ${String(e)}`; } };
const reasonOf = (r: unknown) => (typeof r === "object" && r ? [(r as { ok: boolean }).ok, (r as { reason?: string }).reason ?? null] : r);
const together = attempt(() => next.nextStepsFor([cardFor(campA), cardFor(campB)]));
const budgetsAfter = (cards: NextStep[], list: CampaignNow[]) => new Map(list.map((c, i) => [c.id, cards[i].change?.kind === "raise" ? cards[i].change!.after.dailyBudgetCents : c.dailyBudgetCents] as const));
const dailyBudgetSum = (daily: ReadonlyMap<string, number>) => [...daily.values()].reduce((sum, cents) => sum + cents, 0);
is("the cards shown together keep their combined daily budgets inside the daily limit", Array.isArray(together) ? dailyBudgetSum(budgetsAfter(together, [campA, campB])) <= pair.maxDailyCents : together, true);
is("the first card gets the room, the second says there is none", Array.isArray(together) ? together.map((s) => [s.change?.after.dailyBudgetCents ?? null, s.note]) : together, [[6_000, null], [null, "Your ad limits leave no room to raise its budget."]]);
is("one card alone reads the same through either function", JSON.stringify(attempt(() => next.nextStepsFor([base()]))), JSON.stringify([nextStepFor(base())]));
// The creator confirmed A ($50 to $60); B's card, prepared before that on its own, offered $50 to $60 too.
const cardB = nextStepFor(cardFor(campB)).change as NextStepChange;
const liveAfterA = [camp({ id: "a", dailyBudgetCents: 6_000 }), campB];
const confirmB = attempt(() => next.confirmChange(cardB, { limits: pair, all: liveAfterA, lastRaisedDay: "never" }));
is("confirming the second raise, against the budgets as they are, is refused", reasonOf(confirmB), [false, "limits"]);
is("and it says why, honestly, with nothing changed", typeof confirmB === "object" && !confirmB.ok ? confirmB.message : confirmB, "With your other campaigns' budgets as they are, this raise would pass your ad limits, so nothing was changed.");
const confirmA = attempt(() => next.confirmChange(nextStepFor(cardFor(campA)).change as NextStepChange, { limits: pair, all: [campA, campB], lastRaisedDay: "never" }));
is("the first raise, still inside the limits with the live budgets, may be applied; the day to keep is today", confirmA, { ok: true, raisedOn: TODAY });
const moved = attempt(() => next.confirmChange(cardB, { limits: pair, all: [campA, camp({ id: "b", dailyBudgetCents: 5_500 })], lastRaisedDay: "never" }));
is("a budget changed since the card was made is refused", reasonOf(moved), [false, "changed"]);
const gone = attempt(() => next.confirmChange(cardB, { limits: pair, all: [campA], lastRaisedDay: "never" }));
is("a campaign missing from the live budgets is unknown, refused", reasonOf(gone), [false, "unknown"]);
const badLive = attempt(() => next.confirmChange(cardB, { limits: pair, all: [camp({ id: "a", dailyBudgetCents: -50_000 }), campB], lastRaisedDay: "never" }));
is("a live budget that is not a whole number at or above zero is unknown, refused", reasonOf(badLive), [false, "unknown"]);
const noRules = attempt(() => next.confirmChange(cardB, { limits: null, all: [campA, campB], lastRaisedDay: "never" }));
is("no approved limits at confirmation: refused", reasonOf(noRules), [false, "rules"]);
const stretched: NextStepChange = { ...cardB, after: { status: "ACTIVE", dailyBudgetCents: 6_100 } };
const tooFar = attempt(() => next.confirmChange(stretched, { limits, all: [campA, campB], lastRaisedDay: "never" }));
is("a raise of more than the most a day allows is refused, even inside the limits", reasonOf(tooFar), [false, "step"]);
const pausing = nextStepFor(base({ salesByDay: { "2026-10-22": 5_000 } })).change as NextStepChange;
is("a pause lowers spend and is never refused by the limits", attempt(() => next.confirmChange(pausing, { limits: { ...limits, maxDailyCents: 1_000 }, all: [camp()], lastRaisedDay: TODAY })), { ok: true, raisedOn: null });
let summed = 0;
for (const day of [10_000, 10_500, 11_000, 11_999, 12_000, 13_000, 50_000]) {
  // From $100, the two budgets as they are; below that the limit is already passed before any raise.
  const r = { ...limits, maxDailyCents: day };
  const cards = attempt(() => next.nextStepsFor([campA, campB].map((c) => base({ campaign: c, all: [campA, campB], limits: r }))));
  if (!Array.isArray(cards)) { summed += 1; continue; }
  if (dailyBudgetSum(budgetsAfter(cards, [campA, campB])) > r.maxDailyCents) summed += 1;
  // Each card made on its own, then confirmed one after the other against the live budgets: never past the limit.
  const liveNow = [campA, campB].map((c) => ({ ...c }));
  for (const [i, c] of [campA, campB].entries()) {
    const change = nextStepFor(base({ campaign: c, all: [campA, campB], limits: r })).change;
    if (!change) continue;
    const ok = attempt(() => next.confirmChange(change, { limits: r, all: liveNow, lastRaisedDay: "never" }));
    if (typeof ok === "object" && ok.ok) liveNow[i].dailyBudgetCents = change.after.dailyBudgetCents;
  }
  if (liveNow.reduce((sum, c) => sum + c.dailyBudgetCents, 0) > r.maxDailyCents) summed += 1;
}
is("for every daily limit, the cards together and the confirmations one by one stay under the daily cap", summed, 0);

part("At most one raise a day, by at most 20% (Claude 1's review on #3196, BAIXO 2)");
const at6000 = camp({ dailyBudgetCents: 6_000 });
const raisedToday = nextStepFor(base({ campaign: at6000, all: [at6000], lastRaisedDay: TODAY }));
is("raised today ($50 to $60): recomputing offers no second raise ($60 to $72)", [raisedToday.state, raisedToday.change, raisedToday.ask], ["paid_back", null, null]);
is("and the note says why", raisedToday.note, "Its budget was already raised today. A budget is raised at most once a day.");
is("raised yesterday: a raise may be offered again", nextStepFor(base({ lastRaisedDay: TODAY - 1 })).change?.after.dailyBudgetCents, 6_000);
const twice = attempt(() => next.confirmChange(paid.change as NextStepChange, { limits, all: [camp()], lastRaisedDay: TODAY }));
is("confirming a second raise on the same day is refused", reasonOf(twice), [false, "rate"]);
is("a pause on a campaign raised today is still offered", nextStepFor(base({ salesByDay: { "2026-10-22": 5_000 }, lastRaisedDay: TODAY })).change?.kind, "pause");
for (const [what, day] of [["not a number", NaN], ["not a whole day", TODAY - 0.5], ["in the future", TODAY + 1], ["missing", undefined], ["null", null]] as const) {
  const s = nextStepFor(base({ lastRaisedDay: day as unknown as number }));
  is(`the day of the last raise ${what}: unknown, never read as "never", no change`, [s.state, s.unknown, s.change], ["unknown", "raised", null]);
  const c = attempt(() => next.confirmChange(paid.change as NextStepChange, { limits, all: [camp()], lastRaisedDay: day as unknown as number }));
  is(`the day of the last raise ${what}: confirming is refused`, reasonOf(c), [false, "unknown"]);
}

part("Every other campaign's figures are read whole too (Claude 1's review on #3196, BAIXO 3)");
// A negative budget elsewhere lowered the sum: with a $50 daily limit, the campaign was offered $50 to $60.
const badOthers: [string, CampaignNow[]][] = [
  ["a daily budget below zero", [camp(), camp({ id: "c2", dailyBudgetCents: -50_000 })]],
  ["a daily budget that is not a number", [camp(), camp({ id: "c2", dailyBudgetCents: NaN })]],
  ["a daily budget that is not whole", [camp(), camp({ id: "c2", dailyBudgetCents: 100.5 })]],
  ["a spend so far below zero", [camp(), camp({ id: "c2", spentCents: -900_000 })]],
  ["days left that are not a number", [camp(), camp({ id: "c2", daysLeft: NaN })]],
  ["sales that are not whole", [camp(), camp({ id: "c2", sales: 1.5 })]],
  ["a status that is not known", [camp(), camp({ id: "c2", status: "DELETED" as unknown as "ACTIVE" })]],
  ["the same campaign listed twice", [camp(), camp({ id: "c2", dailyBudgetCents: 40_000 }), camp({ id: "c2", status: "PAUSED" })]],
];
for (const [what, list] of badOthers) {
  const s = nextStepFor(base({ limits: { ...limits, maxDailyCents: 5_000 }, all: list }));
  is(`another campaign with ${what}: unknown, no raise`, [s.state, s.unknown, s.change, s.ask], ["unknown", "others", null, null]);
}

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
  // Claude 4's probes on #3196: a malformed figure became "$NaN back" or a raise.
  ["a day's sales are not a number", { salesByDay: { ...sales, "2026-10-21": NaN } }, "sales"],
  ["a day's sales are infinite", { salesByDay: { ...sales, "2026-10-21": Infinity } }, "sales"],
  ["a day's sales are below zero", { salesByDay: { ...sales, "2026-10-21": -1 } }, "sales"],
  ["a day's sales are not whole cents", { salesByDay: { ...sales, "2026-10-21": 0.5 } }, "sales"],
  ["a day's refunds are not a number", { refundsByDay: { "2026-10-25": NaN } }, "refunds"],
  ["a day's refunds are below zero", { refundsByDay: { "2026-10-25": -6_000 } }, "refunds"],
  ["the campaign's sales are not a number", { campaign: camp({ sales: NaN }) }, "sales"],
  ["the campaign's sales are not whole", { campaign: camp({ sales: 4.5 }) }, "sales"],
  ["its spend so far is not a number", { campaign: camp({ spentCents: NaN }) }, "campaign"],
  ["its daily budget is not a number", { campaign: camp({ dailyBudgetCents: NaN }) }, "campaign"],
  ["its days left are not a number", { campaign: camp({ daysLeft: NaN }) }, "campaign"],
  ["today is not a number", { campaign: camp({ today: NaN }) }, "campaign"],
  ["a spend line is not a number", { spends: [{ ...spends[0], cents: NaN }] }, "spend"],
  ["a spend line is below zero", { spends: [spends[0], { ...spends[0], id: "s2", cents: -5_000 }] }, "spend"],
  ["an active campaign with a daily budget of 0", { campaign: camp({ dailyBudgetCents: 0 }) }, "budget"],
];
for (const [what, extra, reason] of unknowns) {
  const s = nextStepFor(base(extra));
  is(`${what}: unknown, with its reason, no figure and no step`, [s.state, s.unknown, s.spentCents, s.backCents, s.days, s.change, s.ask], ["unknown", reason, null, null, null, null, null]);
  is(`${what}: says it is unknown, never $0`, [s.says === NEXT_STEP_UNKNOWN[reason], /\$0\b|\$0\.00/.test(words(s).join(" "))], [true, false]);
  is(`${what}: no NaN or Infinity in any word`, /NaN|Infinity/.test(words(s).join(" ")), false);
}
is("a partial read stays unknown even when the money would have paid back", nextStepFor(base({ results: { partial: true, salesKnown: true }, salesByDay: { "2026-10-20": 90_000 } })).state, "unknown");

part("The words pass the ad honesty check and read simply");
const scenarios: NextStep[] = [paid, tightDay, full, none, notYet, early, refunded, again,
  nextStepFor(base({ campaign: camp({ sales: 1 }) })), nextStepFor(base({ campaign: camp({ status: "PAUSED" }) })),
  over, margin, tooEarly, otherNet, otherProduct, outPause, raisedToday,
  ...(Array.isArray(together) ? together : []),
  ...unknowns.map(([, extra]) => nextStepFor(base(extra))), ...Object.values(NEXT_STEP_UNKNOWN).map((says) => ({ ...paid, says, note: null, ask: null, change: null }))];
const refusals = [confirmB, moved, gone, badLive, noRules, tooFar, twice].flatMap((r) => (typeof r === "object" && !r.ok ? [r.message] : []));
is("every refusal at confirmation is said in words", refusals.length, 7);
const all = [...new Set([...scenarios.flatMap(words), ...refusals])];
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
