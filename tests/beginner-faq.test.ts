/**
 * The one answer every feature page gives to its own "Can I try … before paying?"
 * (534 [FQ1], lib/beginner-faq.ts; this check added 2 November 2026, unit
 * 28). Checked against what the code does: a store without a paid plan, a
 * trial included, has smaller figures than the cheapest plan, counted over
 * the whole trial in a trial and by calendar month without a plan; it needs
 * a place among the month's stores without a paid plan, and a paying store
 * never does; the answer says both without "each month" for the trial and
 * promises no message; the uploads sentence follows the upload policy; the
 * demo only while nothing is on sale; one space between sentences.
 */
import { UNPAID_ROOM, tryBeforePaying, uploadsWait } from "@/lib/beginner-faq";
import { ALLOWANCE_KINDS, NON_PAYING_ALLOWANCES, STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { admitNonPaying } from "@/lib/free-pool";
import { AUTOMATIC_UPLOAD_CAPS } from "@/lib/upload-budget-policy";
import { FREE_POOL_BASE_STORES } from "@/lib/free-pool-rules";
import { TRIAL_DAYS } from "@/lib/plan";
import { done, is, part } from "./check";

const DAY = 86_400_000;
// A month no other check counts places in, so the pool starts empty.
const now = Date.UTC(2031, 4, 15, 12);
const trialStore = { subscriptionActive: true, trialEnds: (now + 5 * DAY) / 1000, tier: "creator" as const, cycle: "month" as const, sid: "s1" };
const noPlan = { subscriptionActive: false, trialEnds: 0, tier: "creator" as const, cycle: "month" as const, sid: "s2" };
const paying = { subscriptionActive: true, trialEnds: 0, tier: "creator" as const, cycle: "month" as const, sid: "s3" };

async function main() {
part("What the code does for a store without a paid plan");
is("each counted kind of work is smaller without a paid plan and in the trial than on the cheapest plan", ALLOWANCE_KINDS.every((k) => NON_PAYING_ALLOWANCES.none[k] < STORE_ALLOWANCES.creator[k] && NON_PAYING_ALLOWANCES.trial[k] < STORE_ALLOWANCES.creator[k]), true);
const inTrial = allowanceWindow(trialStore as never, now);
const without = allowanceWindow(noPlan as never, now);
is("counted over the whole trial in a trial, by calendar month (UTC) without a plan", [inTrial ? inTrial.end - inTrial.start : null, without ? new Date(without.start).getUTCDate() : null, without ? new Date(without.start).getUTCHours() : null], [TRIAL_DAYS * DAY, 1, 0]);
const others = Array.from({ length: FREE_POOL_BASE_STORES + 1 }, (_, i) => ({ ...noPlan, sid: `pool-${i}` }));
const admitted: boolean[] = [];
for (const store of [trialStore, ...others]) admitted.push(await admitNonPaying(store as never, now));
is("a trial or no plan takes one of the month's places, and past them is refused; a paying store never needs one", [admitted.slice(0, FREE_POOL_BASE_STORES).every(Boolean), admitted[FREE_POOL_BASE_STORES], admitted[FREE_POOL_BASE_STORES + 1], await admitNonPaying(paying as never, now)], [true, false, false, true]);

part("The answer, in both states");
const today = tryBeforePaying("A thing", "a thing", false, TRIAL_DAYS);
const later = tryBeforePaying("A thing", "a thing", true, TRIAL_DAYS);
is("both say what a store without a paid plan meets", [today.includes(UNPAID_ROOM), later.includes(UNPAID_ROOM)], [true, true]);
is("the trial's limits not said to be monthly, no message promised", [UNPAID_ROOM.includes("for the whole trial or each month without a plan"), /the studio says so|tells you/.test(UNPAID_ROOM)], [true, false]);
is("the uploads sentence follows the upload policy", [today.includes(uploadsWait("setup")), AUTOMATIC_UPLOAD_CAPS.setup.opens === 0 ? today.includes("Files and lesson videos can be uploaded once a paid plan starts.") : true], [true, true]);
is("the demo only while nothing is on sale", [today.includes("live demo store"), later.includes("live demo store")], [true, false]);
is("one space between sentences, never two", /\s{2}/.test(today + " " + later), false);
is("no figure but the trial's days", /\d/.test((today + later).split(`${TRIAL_DAYS}-day`).join("")), false);

done();
}

void main();
