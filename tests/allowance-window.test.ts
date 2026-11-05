/**
 * The window every monthly allowance is counted in (lib/allowance-window.ts,
 * 17 October 2026): one per payment for a store that pays us, its trial for
 * a store in its free trial, the calendar month for the rest, and nothing at
 * all for a paying store whose period is not known.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LONGEST_WINDOW_DAYS, RENEW_GRACE_SECONDS, WINDOW_ID, addMonthsMs, allowanceWindow, calendarWindow, isPeriod, keepSecondsFor, ledgerMonthOf, opensAgainWords, resetWords, samePeriod, windowAt, windowId } from "@/lib/allowance-window";
import { periodOf, stateOf } from "@/lib/billing";
import { TRIAL_DAYS } from "@/lib/plan";

const DAY = 86_400_000;
const at = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);
const s = (ms: number) => Math.floor(ms / 1000);
const paying = (start: number, end: number, cycle: "month" | "year" = "month", renews = true) => ({
  subscriptionActive: true, subscriptionId: "sub_Window00001", trialEnds: 0, planEndedAt: "", cycle, period: { start: s(start), end: s(end), renews },
});

test("a monthly plan's window is its billing period, whatever day it began", () => {
  const store = paying(at(2026, 10, 19, 14), at(2026, 11, 19, 14));
  const w = allowanceWindow(store, at(2026, 11, 1))!;
  assert.deepEqual([w.id, w.start, w.end, w.billing], ["2026-10-19", at(2026, 10, 19, 14), at(2026, 11, 19, 14), true]);
  // One payment touches two calendar months, and is still one window.
  assert.equal(windowId(store, at(2026, 10, 25)), windowId(store, at(2026, 11, 18)));
  assert.equal(ledgerMonthOf(w), "2026-10");
  assert.ok(WINDOW_ID.test(w.id) && WINDOW_ID.test(calendarWindow(at(2026, 11, 3)).id));
  assert.ok(keepSecondsFor(w, at(2026, 11, 1)) > (at(2026, 11, 19, 14) - at(2026, 11, 1)) / 1000);
});

test("a yearly plan's months start on the day of the month its year began, clamped like Stripe's", () => {
  const start = at(2026, 1, 31, 9);
  const store = paying(start, addMonthsMs(start, 12), "year");
  const ids = [at(2026, 2, 1), at(2026, 2, 28, 10), at(2026, 3, 30), at(2026, 3, 31, 10), at(2026, 12, 31, 10)].map((t) => windowId(store, t));
  assert.deepEqual(ids, ["2026-01-31", "2026-02-28", "2026-02-28", "2026-03-31", "2026-12-31"]);
  // Twelve windows in a year's payment, none sharing a name.
  const names = new Set(Array.from({ length: 365 }, (_, i) => windowId(store, start + i * DAY)));
  assert.equal(names.size, 12);
});

test("past a renewing period's end the next window is used for a short grace, then nothing", () => {
  const end = at(2026, 11, 19, 14);
  const store = paying(at(2026, 10, 19, 14), end);
  assert.equal(windowId(store, end + 60_000), "2026-11-19");
  assert.equal(windowId(store, end + RENEW_GRACE_SECONDS * 1000 + 1), null);
  // A period set to stop gets no grace: what it paid for ends there.
  assert.equal(windowId(paying(at(2026, 10, 19, 14), end, "month", false), end + 60_000), null);
});

test("unknown is closed: a paying store with no period, a broken one, or a clock that is not one, has no window", () => {
  const base = paying(at(2026, 10, 1), at(2026, 11, 1));
  assert.equal(allowanceWindow({ ...base, period: null }, at(2026, 10, 5)), null);
  assert.equal(allowanceWindow({ ...base, period: undefined }, at(2026, 10, 5)), null);
  assert.equal(allowanceWindow(base, Number.NaN), null);
  for (const period of [{ start: 5, end: 4, renews: true }, { start: 1, end: 1 + 400 * 86_400, renews: true }, { start: 1.5, end: 9, renews: true }, { start: 1, end: 9 }]) {
    assert.equal(isPeriod(period), false, JSON.stringify(period));
    assert.equal(allowanceWindow({ ...base, period: period as never }, at(2026, 10, 5)), null);
  }
  assert.ok(/Open your studio/.test(resetWords({ ...base, period: null }, at(2026, 10, 5))));
});

test("a free trial is one window from the day it began; no plan, an ended plan and a plan with nothing behind it keep the calendar", () => {
  const trialEnds = s(at(2026, 11, 3, 12));
  const trial = { subscriptionActive: true, subscriptionId: "sub_Trial000001", trialEnds, planEndedAt: "" };
  const w = allowanceWindow(trial, at(2026, 10, 25))!;
  assert.deepEqual([w.id, w.start, w.end, w.billing], [new Date(trialEnds * 1000 - TRIAL_DAYS * DAY).toISOString().slice(0, 10), trialEnds * 1000 - TRIAL_DAYS * DAY, trialEnds * 1000, false]);
  assert.equal(windowId(trial, at(2026, 11, 2)), w.id, "one trial, across the 1st");
  assert.equal(windowId({ subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "" }, at(2026, 10, 25)), "2026-10");
  assert.equal(windowId({ subscriptionActive: false, subscriptionId: "sub_Ended0000001", trialEnds: 0, planEndedAt: "2026-09-01T00:00:00.000Z" }, at(2026, 10, 25)), "2026-10");
  assert.equal(windowId({ subscriptionActive: true, subscriptionId: null, trialEnds: 0, planEndedAt: "" }, at(2026, 10, 25)), "2026-10", "the demo store");
});

test("the period is read from Stripe's subscription, on the item first, and none while trialing", () => {
  const sub = { status: "active", items: { data: [{ current_period_start: s(at(2026, 10, 19)), current_period_end: s(at(2026, 11, 19)), price: { unit_amount: 2200, recurring: { interval: "month" } } }] } };
  const state = stateOf(sub);
  assert.equal(state.state, "active");
  assert.deepEqual(state.state === "active" ? state.period : null, { start: s(at(2026, 10, 19)), end: s(at(2026, 11, 19)), renews: true });
  assert.equal(periodOf(sub, true, false), null);
  assert.deepEqual(periodOf({ ...sub, cancel_at_period_end: true }, false, true), { start: s(at(2026, 10, 19)), end: s(at(2026, 11, 19)), renews: false });
  assert.equal(periodOf({ status: "active" }, false, false), null);
  assert.equal(samePeriod({ start: 1, end: 2, renews: true }, { start: 1, end: 2, renews: true }), true);
  assert.equal(samePeriod({ start: 1, end: 2, renews: true }, { start: 1, end: 2, renews: false }), false);
  assert.equal(samePeriod(null, null), true);
});

test("the words a refusal ends with say the day it opens again", () => {
  const store = paying(at(2026, 10, 19, 14), at(2026, 11, 19, 14));
  assert.equal(opensAgainWords(allowanceWindow(store, at(2026, 10, 20))!, at(2026, 10, 20)), "November 19");
  assert.equal(resetWords(store, at(2026, 10, 20)), "This opens again with your next billing month, on November 19 (UTC).");
  assert.equal(resetWords({ subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "" }, at(2026, 12, 20)), "This opens again on January 1, 2027 (UTC).");
});

test('a funded paid period never infers the next allowance during legacy renewal grace',()=>{
 const store=paying(at(2026,10,19),at(2026,11,19));
 const funded={...store,period:{...store.period,funded:true as const}};
 assert.ok(allowanceWindow(funded,at(2026,11,18)));
 for(const now of [at(2026,11,19),at(2026,11,19)+1000,at(2026,11,20)]){
  assert.equal(allowanceWindow(funded,now),null);
  assert.ok(allowanceWindow(store,now),'unmarked existing contracts keep their legacy grace');
 }
 assert.equal(samePeriod(store.period,funded.period),false);
 assert.equal(samePeriod(funded.period,{...funded.period}),true);
 assert.equal(isPeriod({...funded.period,funded:false}),false);
});
test('a funded annual period keeps twelve anchored months and no thirteenth window',()=>{
 const store=paying(at(2026,1,31,12),at(2027,1,31,12),'year');
 const funded={...store,period:{...store.period,funded:true as const}};
 for(let month=0;month<12;month++){
  const now=addMonthsMs(at(2026,1,31,12),month)+1000;
  assert.deepEqual(allowanceWindow(funded,now),allowanceWindow(store,now));
 }
 assert.equal(allowanceWindow(funded,at(2027,1,31,12)),null);
 assert.ok(allowanceWindow(store,at(2027,1,31,12)));
});

// Review of #2205 (C3-112): the grace window after a period whose end was cut to a short month's last day ends where
// Stripe ends the next period, counted from the anchor; and a billing month's counter is kept at least its longest.
test("the window right after a period cut to February's end ends on the anchor's day, as Stripe's next period does", () => {
  // Anchor 31, a common year: 31 January to 28 February, then 28 February to 31 March (not 28 March).
  const jan31 = paying(at(2027, 1, 31, 9), at(2027, 2, 28, 9));
  const grace = allowanceWindow(jan31, at(2027, 3, 1, 9))!;
  assert.deepEqual([grace.id, grace.start, grace.end, grace.billing], ["2027-02-28", at(2027, 2, 28, 9), at(2027, 3, 31, 9), true]);
  // Worked out ahead, on 10 February, for an email scheduled for 1 March: the same window.
  assert.deepEqual(windowAt(jan31, at(2027, 3, 1, 9)), grace);
  // Its counter, made on 10 February, is still there on the last day of that window, and a day more.
  const keep = keepSecondsFor(grace, at(2027, 2, 10));
  assert.ok(at(2027, 2, 10) + keep * 1000 >= at(2027, 3, 31, 9) + DAY, String(keep));
  // Anchor 30 in a common year: 30 January to 28 February, then to 30 March.
  const jan30 = paying(at(2027, 1, 30, 9), at(2027, 2, 28, 9));
  assert.equal(allowanceWindow(jan30, at(2027, 3, 1))!.end, at(2027, 3, 30, 9));
  // Anchor 31 after a leap day: 31 January to 29 February 2028, then to 31 March.
  const leap = paying(at(2028, 1, 31, 9), at(2028, 2, 29, 9));
  assert.equal(allowanceWindow(leap, at(2028, 3, 1))!.end, at(2028, 3, 31, 9));
  // A period not cut keeps a month from its own end: 15 February to 15 March, then to 15 April.
  const mid = paying(at(2027, 2, 15, 9), at(2027, 3, 15, 9));
  assert.equal(allowanceWindow(mid, at(2027, 3, 16))!.end, at(2027, 4, 15, 9));
  // A partial first period (Codex H, #2269): 31 January to 15 February, before the first whole invoice. The next begins
  // on its end, 15 February, and runs to 15 March; never 28 February to 31 March, which begins after now.
  const partial = paying(at(2027, 1, 31, 9), at(2027, 2, 15, 9));
  const afterPartial = allowanceWindow(partial, at(2027, 2, 16, 9))!;
  assert.deepEqual([afterPartial.id, afterPartial.start, afterPartial.end], ["2027-02-15", at(2027, 2, 15, 9), at(2027, 3, 15, 9)]);
  assert.deepEqual(windowAt(partial, at(2027, 3, 20, 9))?.start, at(2027, 3, 15, 9));
  // A yearly plan whose period began on a leap day: the next year begins on its cut end and its first month runs to 28 March.
  const yearly = paying(at(2024, 2, 29, 9), at(2025, 2, 28, 9), "year");
  const first = allowanceWindow(yearly, at(2025, 3, 1))!;
  assert.deepEqual([first.id, first.end], ["2025-02-28", at(2025, 3, 28, 9)]);
});

test("a billing month's counter is kept at least the longest month from its start, a calendar month's to its end", () => {
  const short = { id: "2027-02-28", start: at(2027, 2, 28), end: at(2027, 3, 28), billing: true };
  const now = at(2027, 2, 10);
  assert.ok(now + keepSecondsFor(short, now) * 1000 >= short.start + (LONGEST_WINDOW_DAYS + 1) * DAY);
  const calendar = calendarWindow(at(2027, 2, 10));
  assert.equal(keepSecondsFor(calendar, now), Math.ceil((calendar.end - now) / 1000) + 86_400);
});
