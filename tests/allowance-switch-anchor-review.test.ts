/**
 * Review of #4561 (Claude 1 cloud R, 14 November 2026, confirmed by Claude 2 cloud K): RED probes for the allowance
 * anchor, kept as the reviewers wrote them (one title spelled the American way: "canceling"). RED 1 and RED 2 passed on main and failed on the first head
 * (a switch on the same UTC day the window opened gave two allowances where main gives one); RED 3 to RED 5 failed on
 * both (a grid moved to a cut day, an anchor lost to an inactive write of the same subscription, and a period read as
 * unknown before the switch). Synthetic stores only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { addMonthsMs, allowanceWindow } from "@/lib/allowance-window";
import { takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { claimHandle, ensureStatsId, setSubscription as writeSubscription, storeForEmail } from "@/lib/store";

const HOUR = 3_600_000;
const at = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);
const s = (ms: number) => Math.floor(ms / 1000);
const read = async (email: string) => (await storeForEmail(email))!;
/**
 * setSubscription decides the anchor at the moment of the write (Date.now): each write here is made at the moment it
 * stands for, never on the real clock, so these checks read the same on any day they run.
 */
let clock = 0;
const realNow = Date.now;
async function setSubscription(...args: Parameters<typeof writeSubscription>): ReturnType<typeof writeSubscription> {
  Date.now = () => clock;
  try { return await writeSubscription(...args); } finally { Date.now = realNow; }
}
let n = 0;
async function paying(cycle: "month" | "year", startMs: number, endMs: number): Promise<string> {
  n += 1;
  const email = `red4561-${n}@example.com`;
  await claimHandle(email, `redanchor${n}`, "Red Anchor", "");
  await ensureStatsId(email);
  clock = startMs;
  assert.ok(await setSubscription(email, { customerId: "cus_RedAnchor001", subscriptionId: "sub_RedAnchor001", active: true, tier: "creator", cycle,
    period: { start: s(startMs), end: s(endMs), renews: true } }));
  return email;
}
const period = (cycle: "month" | "year", startMs: number, renews = true) => ({ start: s(startMs), end: s(addMonthsMs(startMs, cycle === "year" ? 12 : 1)), renews });
beforeEach(() => redis.clear());

test("RED 1: a same-day switch and back, then cancel: one month paid, one allowance (main gives one)", async () => {
  const T0 = at(2026, 11, 3, 12);
  const email = await paying("month", T0, addMonthsMs(T0, 1));
  const first = await read(email);
  const limit = allowanceFor(first, "email", (T0 + HOUR) / 1000);
  assert.equal((await takeAllowance(first, "email", limit, T0 + HOUR)).ok, true, "the month's emails are used");
  clock = T0 + 2 * HOUR;
  assert.ok(await setSubscription(email, { active: true, cycle: "year", period: period("year", T0 + 2 * HOUR) }));
  clock = T0 + 3 * HOUR;
  assert.ok(await setSubscription(email, { active: true, cycle: "month", period: period("month", T0 + 3 * HOUR) }));
  clock = T0 + 4 * HOUR;
  assert.ok(await setSubscription(email, { active: true, cycle: "month", period: period("month", T0 + 3 * HOUR, false) }));
  const last = await read(email);
  const probe = addMonthsMs(T0, 1) + HOUR;
  assert.equal((await takeAllowance(last, "email", 1, probe)).ok, false, `a second full allowance opened at ${allowanceWindow(last, probe)?.id} for the two hours left of one paid month`);
});

test("RED 2: a yearly store moving to monthly on the day its month began, then canceling, gets one allowance for that month", async () => {
  const Y = at(2026, 1, 1, 10);
  const email = await paying("year", Y, addMonthsMs(Y, 12));
  const mar = addMonthsMs(Y, 2);
  const store = await read(email);
  const limit = allowanceFor(store, "email", (mar + HOUR) / 1000);
  assert.equal((await takeAllowance(store, "email", limit, mar + HOUR)).ok, true, "March's emails are used");
  clock = mar + 2 * HOUR;
  assert.ok(await setSubscription(email, { active: true, cycle: "month", period: period("month", mar + 2 * HOUR, false) }));
  const monthly = await read(email);
  const probe = addMonthsMs(mar, 1) + HOUR;
  assert.equal((await takeAllowance(monthly, "email", 1, probe)).ok, false, `a second full allowance opened at ${allowanceWindow(monthly, probe)?.id}`);
});

test("RED 3: an anchor taken from a window cut to a short month keeps the grid's own day (31st), not the cut day", async () => {
  const Y = at(2026, 1, 31, 10);
  const email = await paying("year", Y, addMonthsMs(Y, 12));
  const before = await read(email);
  assert.equal(allowanceWindow(before, at(2026, 3, 29))?.id, "2026-02-28", "without a switch, 29 March is still in the month of 28 February");
  clock = at(2026, 3, 5, 10);
  assert.ok(await setSubscription(email, { active: true, cycle: "month", period: period("month", at(2026, 3, 5, 10)) }));
  const after = await read(email);
  assert.equal(allowanceWindow(after, at(2026, 3, 29))?.id, "2026-02-28", "after the switch the next window opens on the day it would have (31 March)");
});

test("RED 4: the same subscription written inactive and then active again keeps its grid", async () => {
  const T0 = at(2026, 11, 3, 12);
  const email = await paying("month", T0, addMonthsMs(T0, 1));
  const first = await read(email);
  const limit = allowanceFor(first, "email", (T0 + HOUR) / 1000);
  assert.equal((await takeAllowance(first, "email", limit, T0 + HOUR)).ok, true);
  const p = period("month", T0 + 10 * 24 * HOUR);
  clock = T0 + 10 * 24 * HOUR;
  assert.ok(await setSubscription(email, { active: true, cycle: "month", period: p }));
  assert.equal((await takeAllowance(await read(email), "email", 1, T0 + 11 * 24 * HOUR)).ok, false, "anchored: nothing new");
  clock = T0 + 10 * 24 * HOUR + HOUR;
  assert.ok(await setSubscription(email, { active: false }));
  clock = T0 + 10 * 24 * HOUR + 2 * HOUR;
  assert.ok(await setSubscription(email, { subscriptionId: "sub_RedAnchor001", active: true, tier: "creator", cycle: "month", period: p }));
  const back = await read(email);
  assert.equal((await takeAllowance(back, "email", 1, T0 + 12 * 24 * HOUR)).ok, false, `a fresh allowance opened at ${allowanceWindow(back, T0 + 12 * 24 * HOUR)?.id} in the same month`);
});

test("RED 5: a write that carried no period (Stripe gave no ends) before the switch leaves no anchor: a fresh window", async () => {
  const T0 = at(2026, 11, 3, 12);
  const email = await paying("month", T0, addMonthsMs(T0, 1));
  const first = await read(email);
  const limit = allowanceFor(first, "email", (T0 + HOUR) / 1000);
  assert.equal((await takeAllowance(first, "email", limit, T0 + HOUR)).ok, true);
  clock = T0 + 2 * 24 * HOUR;
  assert.ok(await setSubscription(email, { active: true, cycle: "month", period: null }));
  clock = T0 + 5 * 24 * HOUR;
  assert.ok(await setSubscription(email, { active: true, cycle: "year", period: period("year", T0 + 5 * 24 * HOUR) }));
  const after = await read(email);
  assert.equal((await takeAllowance(after, "email", 1, T0 + 6 * 24 * HOUR)).ok, false, `a fresh allowance opened at ${allowanceWindow(after, T0 + 6 * 24 * HOUR)?.id}`);
});
