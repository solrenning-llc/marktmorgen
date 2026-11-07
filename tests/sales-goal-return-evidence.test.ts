import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesGoalCard } from "@/components/sales-goal-card";
import { goalForMonth, readSalesGoal, setSalesGoal, withGoalAvailability } from "@/lib/sales-goal";
import { monthlyMessage, weeklyMessage } from "@/lib/stats-report";
import type { Store } from "@/lib/store";
import type { StatsData } from "@/lib/stats";
import { store as redis } from "./redis-stub";

const stats = "6".repeat(32), key = "nl:goal:" + stats;
const known = JSON.stringify({ cents: 5000, currency: "usd", since: "2026-10" });
async function withReply(reply: unknown[], check: () => Promise<void>) {
  redis.clear();
  const base = redis.pipeline.bind(redis);
  await base([["SET", key, known]]);
  redis.pipeline = async commands => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key ? reply : base(commands);
  try { await check(); assert.deepEqual(await base([["GET", key]]), [known]); }
  finally { redis.pipeline = base; }
}

for (const reply of [[], [undefined], [false], [1], ["{"], [JSON.stringify({ currency: "usd", since: "2026-10" })]]) test("unknown goal read is not a confirmed zero: " + JSON.stringify(reply), async () => {
  await withReply(reply, async () => { const value = await readSalesGoal(stats, "usd"); assert.equal(value.cents < 0, true); });
});

test("confirmed stored target remains exact", async () => {
  await withReply([known], async () => { assert.deepEqual(await readSalesGoal(stats, "usd"), { cents: 5000, since: "2026-10" }); });
});

test("explicit absence or a confirmed other currency remains no target", async () => {
  await withReply([null], async () => { assert.deepEqual(await readSalesGoal(stats, "usd"), { cents: 0, since: "" }); });
  await withReply([known], async () => { assert.deepEqual(await readSalesGoal(stats, "eur"), { cents: 0, since: "" }); });
});

test("writer never evaluates conversion objects", async () => {
  let calls = 0;
  assert.equal(await setSalesGoal(stats, { valueOf() { calls += 1; return 0; } }, "usd"), null);
  assert.equal(calls, 0);
});

test("unknown goal evidence cannot render the existing target as not set", async () => {
  await withReply([], async () => {
    let value;
    try { value = await readSalesGoal(stats, "usd"); } catch { return; }
    const html = renderToStaticMarkup(createElement(SalesGoalCard, { goal: value.cents, byDay: {}, today: "2026-11-05", currency: "usd" }));
    assert.equal(html.includes("Set a goal for the month"), false);
  });
});

const t = { visitors: 10, views: 12, checkouts: 1, sales: 1, cents: 1000 };
const data = {
  sales: "ok", partial: false, paymentsComplete: true, cashflowComplete: true,
  currency: "usd", renewals: null, channelDays: { direct: { "2026-11-04": 1000, "2026-10-04": 1000 } },
  days: [{ date: "2026-10-04", ...t }, { date: "2026-11-04", ...t }],
  totals: { d7: t, d30: t, d90: t, all: t },
  previous: { d7: t, d30: t, d90: t }, products: [], channels: { d7: [], d30: [], d90: [] },
} as unknown as StatsData;
const shop = { name: "Synthetic review shop", handle: "review-shop" } as Store;
const stop = "https://example.test/stop";

for (const kind of ["weekly", "monthly"] as const) test("actual " + kind + " report cannot claim an unknown goal was reached", async () => {
  await withReply([], async () => {
    const goal = await readSalesGoal(stats, "usd");
    const cents = kind === "weekly" ? goal.cents : goalForMonth(goal, "2026-10");
    const message = withGoalAvailability(kind === "weekly" ? weeklyMessage(shop, data, stop, [], cents) : monthlyMessage(shop, data, "2026-10", stop, cents), cents);
    assert.ok(message);
    assert.match(message.text, /saved goal could not be checked/);
    assert.doesNotMatch(message.text, /goal: reached|goal of .* was reached|of -\$0\.01|of \$-0\.01/, message.text);
  });
});

for (const kind of ["weekly", "monthly"] as const) test("actual " + kind + " report keeps known goal controls", () => {
  const render = (goal: number) => withGoalAvailability(kind === "weekly" ? weeklyMessage(shop, data, stop, [], goal) : monthlyMessage(shop, data, "2026-10", stop, goal), goal)!.text;
  assert.doesNotMatch(render(0), /saved goal could not be checked|goal: reached|goal of .* was reached/);
  assert.match(render(500), kind === "weekly" ? /goal: reached/ : /goal of .* was reached/);
  assert.doesNotMatch(render(500), /saved goal could not be checked/);
});
