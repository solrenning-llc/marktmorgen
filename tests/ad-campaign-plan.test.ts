/**
 * 632 [AA2] (b), unit 3: campaigns are planned PAUSED, with an end date, the
 * worst-case maximum from the confirmed ceilings, the creator's limit as a
 * wall, and activation only on confirmation of that very maximum
 * (lib/ad-campaign-plan.ts). Pure; no platform is called.
 */
import { MAX_CAMPAIGN_DAYS, type CampaignInput, activationAllowed, planCampaign, planHash, worstCaseCents } from "@/lib/ad-campaign-plan";
import { done, is, part } from "./check";

const base: CampaignInput = { platform: "meta", dailyBudgetCents: 2_000, start: "2026-11-01", end: "2026-11-30", creatorTotalLimitCents: 100_000, currency: "USD" };
const plan = (over: Partial<CampaignInput>) => planCampaign({ ...base, ...over });
const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

part("Meta: 1.75 × a day, 7 × a week (Sunday to Saturday), daily × days under 7 days");
is("3 days: never more than daily × days", worstCaseCents("meta", 2_000, day("2026-11-03"), 3), 6_000);
// 2026-11-01 is a Sunday: a full week is 7 × daily, not 7 × 1.75.
is("one full week: 7 × daily", worstCaseCents("meta", 2_000, day("2026-11-01"), 7), 14_000);
// Thursday 5 Nov to Wednesday 11 Nov: 3 days in one week (1.75 × 3 = 5.25 × daily) and 4 in the next (7 × daily).
is("a week across two calendar weeks", worstCaseCents("meta", 2_000, day("2026-11-05"), 7), 10_500 + 14_000);
is("November, 30 days from a Sunday", worstCaseCents("meta", 2_000, day("2026-11-01"), 30), 4 * 14_000 + 7_000);
is("rounded up to the cent", worstCaseCents("meta", 1_001, day("2026-11-01"), 7 + 1), 7 * 1_001 + Math.ceil(1_001 * 7 / 4));

part("Google: 2 × a day, 30.4 × a month");
is("5 days: 2 × daily × 5", worstCaseCents("google", 2_000, day("2026-11-10"), 5), 20_000);
is("a whole month: 30.4 × daily", worstCaseCents("google", 2_000, day("2026-11-01"), 30), 60_800);
is("across two months", worstCaseCents("google", 2_000, day("2026-11-20"), 20), 2 * 2_000 * 11 + 2 * 2_000 * 9);

part("TikTok: refused until creating it switched off is confirmed");
is("refused", plan({ platform: "tiktok" }), { ok: false, error: "tiktok_status_unconfirmed", fix: "TikTok campaigns come once it is confirmed that one can be created switched off." });
is("its ceilings are still known for later (1.25 × a day, 7 × a week)", worstCaseCents("tiktok", 2_000, day("2026-11-01"), 3), 7_500);

part("A plan is PAUSED, bounded and inside the creator's limit");
const ok = plan({});
is("made", ok.ok, true);
if (!ok.ok) throw new Error("no plan");
is("created PAUSED", ok.plan.status, "PAUSED");
is("the maximum shown is the worst case, not the budget", [ok.plan.maxSpendCents, ok.plan.dailyBudgetCents * ok.plan.days], [63_000, 60_000]);
is("over the creator's limit: refused", plan({ creatorTotalLimitCents: 62_999 }).ok ? "made" : (plan({ creatorTotalLimitCents: 62_999 }) as { error: string }).error, "over_limit");
is("exactly at the limit: made", plan({ creatorTotalLimitCents: 63_000 }).ok, true);
is("no end date: refused", plan({ end: "" }).ok, false);
is("end before start: refused", (plan({ end: "2026-10-31" }) as { error?: string }).error, "order");
is("too long: refused", (plan({ end: "2027-12-31" }) as { error?: string }).error, "too_long");
is("not a real date: refused", (plan({ start: "2026-02-30" }) as { error?: string }).error, "dates");
is("zero or fractional budget: refused", [(plan({ dailyBudgetCents: 0 }) as { error?: string }).error, (plan({ dailyBudgetCents: 10.5 }) as { error?: string }).error], ["budget", "budget"]);
is("no limit: refused", (plan({ creatorTotalLimitCents: 0 }) as { error?: string }).error, "limit");
is("a year at most", MAX_CAMPAIGN_DAYS, 366);
is("no field for Meta's high demand periods", Object.keys(ok.plan).some((k) => /schedule|demand/i.test(k)), false);

part("Activation only on confirmation of that very maximum");
const confirmation = { planHash: planHash(ok.plan), shownMaxCents: ok.plan.maxSpendCents };
is("confirmed: may be activated", activationAllowed(ok.plan, confirmation), true);
is("no confirmation: never", activationAllowed(ok.plan, null), false);
is("a different maximum shown: never", activationAllowed(ok.plan, { ...confirmation, shownMaxCents: ok.plan.dailyBudgetCents * ok.plan.days }), false);
const changed = { ...ok.plan, dailyBudgetCents: 3_000 };
is("the plan changed after it was shown: the old confirmation does not activate it", activationAllowed(changed, confirmation), false);

done();
