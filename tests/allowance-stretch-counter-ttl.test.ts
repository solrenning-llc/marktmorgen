/**
 * Review of #4561 (Claude 6, 15 November 2026, MEDIUM, money): the stretched last window keeps its id, and must keep
 * its counter. A counter is made once (SET NX EX keepSecondsFor), when the window is still the anchor's plain month; the
 * stretch to the period's end applies only later, so a counter kept to the plain month's end lapsed before the stretched
 * window ended, and the next take made a fresh 0 under the same id: a second full allowance for one paid month. The
 * in-memory Redis is moved on the same clock as each step, so a counter's time to live is honored. Synthetic stores only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { addMonthsMs, allowanceWindow } from "@/lib/allowance-window";
import { takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { claimHandle, ensureStatsId, setSubscription as writeSubscription, storeForEmail } from "@/lib/store";

const at = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);
const s = (ms: number) => Math.floor(ms / 1000);
let clock = 0;
const realNow = Date.now;
/** Each write and read at the moment it stands for, with the in-memory Redis's own clock there too. */
async function when<T>(ms: number, run: () => Promise<T>): Promise<T> {
  clock = ms;
  redis.now = () => clock;
  Date.now = () => clock;
  try { return await run(); } finally { Date.now = realNow; }
}
beforeEach(() => {
  redis.clear();
  redis.now = () => clock;
});

let n = 0;
async function switchedThenStopped(stopBeforeUse: boolean): Promise<{ took: boolean; id: string | undefined; end: number | undefined }> {
  n += 1;
  const email = `ttl4561-${n}@example.com`;
  const yearStart = at(2026, 1, 1, 10);
  const switchAt = at(2026, 3, 16, 10);
  const monthly = { start: s(switchAt), end: s(addMonthsMs(switchAt, 1)), renews: true };
  await when(yearStart, async () => {
    await claimHandle(email, `ttlanchor${n}`, "TTL Anchor", "");
    await ensureStatsId(email);
    assert.ok(await writeSubscription(email, { customerId: "cus_TtlAnchor001", subscriptionId: "sub_TtlAnchor001", active: true, tier: "creator", cycle: "year",
      period: { start: s(yearStart), end: s(addMonthsMs(yearStart, 12)), renews: true } }));
  });
  await when(switchAt, async () => assert.ok(await writeSubscription(email, { active: true, cycle: "month", period: monthly })));
  const stop = () => when(switchAt + 3_600_000, async () => assert.ok(await writeSubscription(email, { active: true, cycle: "month", period: { ...monthly, renews: false } })));
  if (stopBeforeUse) await stop();
  const useAt = at(2026, 3, 21, 10);
  await when(useAt, async () => {
    const store = (await storeForEmail(email))!;
    const limit = allowanceFor(store, "email", useAt / 1000);
    assert.equal((await takeAllowance(store, "email", limit, useAt)).ok, true, "March's emails are used");
  });
  if (!stopBeforeUse) await stop();
  const probe = at(2026, 4, 5, 10);
  return when(probe, async () => {
    const store = (await storeForEmail(email))!;
    const window = allowanceWindow(store, probe);
    return { took: (await takeAllowance(store, "email", 1, probe)).ok, id: window?.id, end: window?.end };
  });
}

test("RED: stopped before the month's emails are used, the stretched window's counter still holds them", async () => {
  const got = await switchedThenStopped(true);
  assert.equal(got.id, "2026-03-01", "the window is March's, stretched");
  assert.equal(got.took, false, `a fresh allowance opened in ${got.id}, which ends ${got.end ? new Date(got.end).toISOString() : "?"}`);
});

test("RED: stopped after they are used, the same", async () => {
  const got = await switchedThenStopped(false);
  assert.equal(got.id, "2026-03-01", "the window is March's, stretched");
  assert.equal(got.took, false, `a fresh allowance opened in ${got.id}, which ends ${got.end ? new Date(got.end).toISOString() : "?"}`);
});
