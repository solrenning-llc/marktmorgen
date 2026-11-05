/** Independent I2 review: unknown goal reads must not announce no target. */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesGoalCard } from "@/components/sales-goal-card";
import { readSalesGoal, setSalesGoal } from "@/lib/sales-goal";
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
  await withReply(reply, async () => { await assert.rejects(readSalesGoal(stats, "usd")); });
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
    assert.equal(html.includes("Set a goal for the month"), false, "5000 is still stored; unknown is not no target");
  });
});
