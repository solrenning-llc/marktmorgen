/**
 * Review of #4561 (Claude 6, 15 November 2026, MEDIUM, money, rule 30): every counter keyed by the allowance window id
 * must outlive the stretched last window, as the store's own figures now do (keepSecondsFor). The visitors' answers
 * (lib/answers.ts), the writing jobs (lib/ai.ts), an affiliate kit's counts (lib/affiliate-kit.ts) and a store's
 * funnel-share uses a month (app/api/store/funnel-share/route.ts) kept a fixed 40 or 32 days, so they lapsed inside a
 * window stretched to the period's end and a second full allowance opened under the same id. The in-memory Redis is
 * moved on the same clock as each step. Since #4698 is in, the imports' moved emails and rows (lib/imports.ts) too.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { addMonthsMs, allowanceWindow, keepSecondsFor, windowKeySeconds } from "@/lib/allowance-window";
import { answersAllowance, takeAnswer } from "@/lib/answers";
import { importAllowanceFor } from "@/lib/import-limits";
import { reserveMoved } from "@/lib/imports";
import { claimHandle, ensureStatsId, setSubscription as writeSubscription, storeForEmail } from "@/lib/store";

const at = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);
const s = (ms: number) => Math.floor(ms / 1000);
let clock = 0;
const realNow = Date.now;
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

/**
 * A yearly store that uses something on 2 Mar 2026 (`spend`, in time order), then switches to monthly on 16 Mar and stops at
 * the period's end (16 Apr): March runs on to it. Claude 6's scenario on #4561.
 */
async function stretched(tier: "creator" | "pro", spend: (email: string) => Promise<void> = async () => {}): Promise<string> {
  const email = `sib4561-${tier}@example.com`;
  const yearStart = at(2026, 1, 1, 10);
  const switchAt = at(2026, 3, 16, 10);
  const monthly = { start: s(switchAt), end: s(addMonthsMs(switchAt, 1)), renews: true };
  await when(yearStart, async () => {
    await claimHandle(email, `sib4561${tier}`, "Siblings", "");
    await ensureStatsId(email);
    assert.ok(await writeSubscription(email, { customerId: "cus_Sib4561Owner1", subscriptionId: "sub_Sib4561Owner1", active: true, tier, cycle: "year",
      period: { start: s(yearStart), end: s(addMonthsMs(yearStart, 12)), renews: true } }));
  });
  await spend(email);
  await when(switchAt, async () => assert.ok(await writeSubscription(email, { active: true, cycle: "month", period: monthly })));
  await when(switchAt + 3_600_000, async () => assert.ok(await writeSubscription(email, { active: true, cycle: "month", period: { ...monthly, renews: false } })));
  return email;
}

test("RED: the month's answers used on 2 Mar stay used on 12 Apr, in the same stretched window", async () => {
  const useAt = at(2026, 3, 2, 10);
  const email = await stretched("pro", (who) => when(useAt, async () => {
    const store = (await storeForEmail(who))!;
    const limit = answersAllowance(store, useAt);
    assert.ok(limit > 0, "a plan with answers");
    for (let i = 0; i < limit; i += 1) assert.equal(await takeAnswer(store, useAt), true);
  }));
  const probe = at(2026, 4, 12, 10);
  const got = await when(probe, async () => {
    const store = (await storeForEmail(email))!;
    return { id: allowanceWindow(store, probe)?.id, took: await takeAnswer(store, probe) };
  });
  assert.equal(got.id, "2026-03-01", "the window is March's, stretched to 16 Apr");
  assert.equal(got.took, false, "a fresh answers allowance opened in the same window");
});

test("windowKeySeconds: at least the floor asked, and at least the window's own keep", async () => {
  const email = await stretched("creator");
  const now = at(2026, 3, 21, 10);
  await when(now, async () => {
    const store = (await storeForEmail(email))!;
    const window = allowanceWindow(store, now)!;
    assert.equal(windowKeySeconds(store, 40 * 86_400, now), Math.max(40 * 86_400, keepSecondsFor(window, now)));
    assert.ok(windowKeySeconds(store, 40 * 86_400, now) * 1000 >= at(2026, 4, 16, 10) - now, "past the stretched end");
  });
});

test("RED: every other counter keyed by the window id takes its time to live from the window", () => {
  const read = (file: string) => readFileSync(file, "utf8");
  assert.match(read("lib/answers.ts"), /\["EXPIRE", key, windowKeySeconds\(store, 40 \* 86_400, now\)\]/);
  assert.match(read("lib/ai.ts"), /\["EXPIRE", key, windowKeySeconds\(store, 40 \* 86_400, now\)\]/);
  const kit = read("lib/affiliate-kit.ts");
  assert.match(kit, /\["EXPIRE", month, kept\]/);
  assert.match(kit, /\["EXPIRE", jobs, kept\]/);
  assert.match(kit, /const kept = windowKeySeconds\(store, 40 \* 86_400, now\.getTime\(\)\);/);
  const share = read("app/api/store/funnel-share/route.ts");
  assert.doesNotMatch(share, /countUse\(storeMonthKey\([^)]*\), [^,]+, MONTH_USE_SECONDS\)/, "a store's month counted with a fixed 32 days");
  // The saved sections' "apply" count is keyed by the same window (Claude 6's MEDIUM on #4561): a fixed 32 days let it
  // lapse inside a stretched window and opened a second priced allowance there.
  const blocks = read("app/api/store/saved-blocks/route.ts");
  assert.doesNotMatch(blocks, /countUse\(storeMonthKey\([^)]*\), [^,]+, MONTH_USE_SECONDS\)/, "the saved sections' applies counted with a fixed 32 days");
  assert.match(blocks, /countUse\(storeMonthKey\(statsId, "apply", month\), limits\.appliesPerMonth, windowKeySeconds\(store, MONTH_USE_SECONDS\)\)/);
});

test("RED: the emails to people brought over, used on 2 Mar, stay used on 12 Apr, in the same stretched window", async () => {
  const useAt = at(2026, 3, 2, 10);
  let cap = 0;
  const email = await stretched("creator", (who) => when(useAt, async () => {
    const store = (await storeForEmail(who))!;
    cap = importAllowanceFor(store, useAt / 1000).movedEmails;
    assert.ok(cap > 0, "a plan whose moved emails are its own figure");
    assert.equal(await reserveMoved(store, cap, useAt), cap);
  }));
  const probe = at(2026, 4, 12, 10);
  const got = await when(probe, async () => {
    const store = (await storeForEmail(email))!;
    return { id: allowanceWindow(store, probe)?.id, took: await reserveMoved(store, 1, probe) };
  });
  assert.equal(got.id, "2026-03-01", "the window is March's, stretched to 16 Apr");
  assert.equal(got.took, 0, "a fresh moved-emails allowance opened in the same window");
});

test("RED: the imports' month counters take their time to live from the window", () => {
  const imports = readFileSync("lib/imports.ts", "utf8");
  assert.doesNotMatch(imports, /windowCountBy\(key, 32 \* 86_400, n\)/, "a window's counter kept a fixed 32 days");
  assert.equal(imports.match(/windowCountBy\(key, windowKeySeconds\(store, 32 \* 86_400, now\), n\)/g)?.length, 2);
});
