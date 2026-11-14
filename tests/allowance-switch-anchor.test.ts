/**
 * A change of billing cycle never opens a second allowance in a month (ALL-199 follow-up, 14 November 2026).
 *
 * A monthly ↔ yearly switch (lib/billing.ts switchPlan, always_invoice) starts a new Stripe period on the day it is
 * made, and the allowance window followed the period (lib/allowance-window.ts), so each switch opened a full new
 * window. With the unused time of the old period given back as credit, a store switching once a day paid about one
 * month and used about thirty months of every figure: Store about -$196, Studio about -$664, Scale about -$1,315 in
 * the month at full use (docs/margin-alignment-2026-10-18.md full-use rows). Rule MR: no paying customer at a loss.
 *
 * Now a period that changes without being a renewal (it does not begin where the last one ended) keeps the store's
 * windows on the grid of the window open when it changed: what was used stays used, the next window opens on the
 * day it would have, and a tier change still applies its own figure at once. A store that never switches keeps its
 * billing month exactly as before. Synthetic stores only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { addMonthsMs, allowanceWindow } from "@/lib/allowance-window";
import { takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);
const s = (ms: number) => Math.floor(ms / 1000);
const T0 = at(2026, 11, 3, 12);

let n = 0;
async function payingStore(): Promise<string> {
  n += 1;
  const email = `switch-anchor-${n}@example.com`;
  await claimHandle(email, `switchanchor${n}`, "Switch Anchor", "");
  await ensureStatsId(email);
  const written = await setSubscription(email, {
    customerId: "cus_SwAnchor0001", subscriptionId: "sub_SwAnchor0001", active: true, tier: "creator", cycle: "month",
    period: { start: s(T0), end: s(addMonthsMs(T0, 1)), renews: true },
  });
  assert.ok(written, "the store's first paid period is written");
  return email;
}

async function switchTo(email: string, cycle: "month" | "year", startMs: number, tier: "creator" | "pro" = "creator"): Promise<void> {
  const written = await setSubscription(email, { active: true, tier, cycle, period: { start: s(startMs), end: s(addMonthsMs(startMs, cycle === "year" ? 12 : 1)), renews: true } });
  assert.ok(written, "the switched period is written");
}

const read = async (email: string) => (await storeForEmail(email))!;

beforeEach(() => redis.clear());

test("switching cycle back and forth inside a month keeps one window: what was used stays used", async () => {
  const email = await payingStore();
  const before = await read(email);
  const limit = allowanceFor(before, "email", (T0 + HOUR) / 1000);
  assert.ok(limit > 0, "the plan has store emails");
  assert.equal((await takeAllowance(before, "email", limit, T0 + HOUR)).ok, true, "the whole month's emails are used");

  await switchTo(email, "year", T0 + DAY);
  const yearly = await read(email);
  const third = await takeAllowance(yearly, "email", 1, T0 + DAY + HOUR);
  assert.equal(third.ok, false, "monthly -> yearly opens no new allowance in the same month");

  await switchTo(email, "month", T0 + 2 * DAY);
  const monthly = await read(email);
  assert.equal((await takeAllowance(monthly, "email", 1, T0 + 2 * DAY + HOUR)).ok, false, "yearly -> monthly opens none either");
  assert.equal(allowanceWindow(monthly, T0 + 2 * DAY + HOUR)?.id, allowanceWindow(before, T0 + HOUR)?.id, "the same window, by name");
});

test("the next window opens on the day the first one would have, and only one per month", async () => {
  const email = await payingStore();
  await switchTo(email, "year", T0 + DAY);
  await switchTo(email, "month", T0 + 2 * DAY);
  await switchTo(email, "year", T0 + 3 * DAY);
  const store = await read(email);
  const next = addMonthsMs(T0, 1);
  assert.equal(allowanceWindow(store, next - HOUR)?.id, new Date(T0).toISOString().slice(0, 10), "still the first window the hour before");
  assert.equal(allowanceWindow(store, next + HOUR)?.id, new Date(next).toISOString().slice(0, 10), "the next one on its own day");
  const limit = allowanceFor(store, "email", (next + HOUR) / 1000);
  assert.equal((await takeAllowance(store, "email", limit, next + HOUR)).ok, true, "a full allowance in the next month");
  assert.equal((await takeAllowance(store, "email", 1, next + 2 * HOUR)).ok, false, "and only one");
});

test("a move to a larger plan still applies its own figure at once, the use already made kept", async () => {
  const email = await payingStore();
  const creator = await read(email);
  const small = allowanceFor(creator, "email", (T0 + HOUR) / 1000);
  assert.equal((await takeAllowance(creator, "email", small, T0 + HOUR)).ok, true);
  await switchTo(email, "year", T0 + DAY, "pro");
  const pro = await read(email);
  const large = allowanceFor(pro, "email", (T0 + DAY + HOUR) / 1000);
  assert.ok(large > small, "the larger plan has a larger figure");
  const took = await takeAllowance(pro, "email", 1, T0 + DAY + HOUR);
  assert.deepEqual(took.ok ? took.left : null, large - small - 1, "the larger figure at once, less what was used");
});

test("control: a store that only renews keeps its billing month, and a new subscription starts afresh", async () => {
  const email = await payingStore();
  const end = addMonthsMs(T0, 1);
  // A renewal: the next period begins exactly where the last one ended.
  assert.ok(await setSubscription(email, { active: true, cycle: "month", period: { start: s(end), end: s(addMonthsMs(end, 1)), renews: true } }));
  const renewed = await read(email);
  assert.equal(allowanceWindow(renewed, end + HOUR)?.id, new Date(end).toISOString().slice(0, 10));
  assert.equal(allowanceWindow(renewed, end + HOUR)?.end, addMonthsMs(end, 1), "the window is the billing period, as before");
  // Another subscription, after a switch: its own billing month, not the old grid.
  await switchTo(email, "year", end + 5 * DAY);
  const other = end + 9 * DAY;
  assert.ok(await setSubscription(email, { subscriptionId: "sub_SwAnchor0002", active: true, cycle: "month", period: { start: s(other), end: s(addMonthsMs(other, 1)), renews: true } }));
  const fresh = await read(email);
  assert.equal(allowanceWindow(fresh, other + HOUR)?.id, new Date(other).toISOString().slice(0, 10));
});

test("the anchor's months are cut as Stripe cuts them, and an anchor never opens a window the period does not pay for", () => {
  const anchor = at(2026, 1, 31, 9);
  const yearly = { subscriptionActive: true, subscriptionId: "sub_SwAnchor0003", trialEnds: 0, planEndedAt: "", cycle: "year" as const,
    period: { start: s(at(2026, 2, 10, 9)), end: s(addMonthsMs(at(2026, 2, 10, 9), 12)), renews: true }, allowanceAnchor: { sub: "sub_SwAnchor0003", at: anchor } };
  assert.deepEqual([at(2026, 2, 15), at(2026, 3, 1), at(2026, 4, 1)].map((t) => allowanceWindow(yearly, t)?.id), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  assert.equal(allowanceWindow(yearly, at(2026, 2, 15))?.end, addMonthsMs(anchor, 1));
  // Unknown is still closed: no period, or a period that has ended, and the anchor opens nothing.
  assert.equal(allowanceWindow({ ...yearly, period: null }, at(2026, 2, 15)), null);
  assert.equal(allowanceWindow({ ...yearly, period: { ...yearly.period, renews: false } }, addMonthsMs(at(2026, 2, 10, 9), 12) + 3_600_000), null);
});
