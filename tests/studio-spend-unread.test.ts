/**
 * The studio's numbers never count unread ad spend as part of it or as $0 (Claude 5 on #2924, MEDIUM A).
 *
 * The studio page read spend with `readSpends(statsId).catch(() => [])`. With Meta's lines unreadable it used the
 * typed lines alone as all of the spend, with no sign; with a typed entry unreadable the `.catch` made the whole
 * spend $0, Meta's readable lines included. Every figure that subtracts ad spend (what remains after ads, the daily
 * result, campaigns less ads, the insights) then showed a profit higher than the store's. Now the page reads
 * `spendsForStudio`, which says which part is unread, and the numbers panel leaves out every figure that uses ad
 * spend while any part is unread, and says so. Synthetic data only, the Redis stub, no provider call.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as adSpend from "@/lib/ad-spend";
import { StatsPanel } from "@/components/stats-panel";
import { readStats, studioStats, type StatsData } from "@/lib/stats";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => {
  throw new Error("No provider in this test");
}) as typeof fetch;

type StudioRead = { spends: { cents: number; source?: string }[]; unread: "meta" | "typed" | null };
const spendsForStudio = (adSpend as unknown as { spendsForStudio?: (statsId: string | null) => Promise<StudioRead> }).spendsForStudio;

const today = new Date().toISOString().slice(0, 10);
const OWNER = "studio-spend-unread@example.com";
const META_LINE = { id: "meta-0123456789ab", channel: "facebook", campaign: "", cents: 500, from: today, to: today };

const fixture = (async () => {
  redis.clear();
  await claimHandle(OWNER, "studio-spend-unread", "Spend Unread Shop", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  assert.equal((await adSpend.addSpend(statsId, { channel: "instagram", campaign: "", cents: 1200, from: today, to: today })).ok, true);
  redis.run(["SET", `nl:metaads:conn:${statsId}`, JSON.stringify({ user: "10150000000000009", token: "sealed", accounts: [{ id: "act_111", name: "Harbor Ads", currency: "usd" }], account: "act_111", sid: store.sid, owner: { email: OWNER, handle: store.handle } })]);
  redis.run(["SET", `nl:stats:${statsId}:spend:meta`, JSON.stringify([META_LINE])]);
  const stats = await readStats(store, Date.now());
  if (!stats) throw new Error("Missing test stats");
  const base = studioStats(store, stats, null, "none", []);
  const data = { ...base, sales: "ok" } as StatsData;
  return { statsId, data };
})();

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
async function withPipeline<T>(swap: (commands: Command[]) => Promise<unknown> | null, run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => (await swap(commands)) ?? real(commands)) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}
/** Meta's lines read in an unknown shape (EXISTS of the connection, GET of the lines). */
const metaUnreadable = (commands: Command[]) => (commands[0]?.[0] === "EXISTS" && String(commands[0][1]).startsWith("nl:metaads:conn:") ? Promise.resolve([1, "[{"]) : null);
/** The typed lines' HGETALL holding one entry that is not JSON beside the whole one. */
const typedUnreadable = (commands: Command[]) =>
  commands.length === 1 && commands[0][0] === "HGETALL" && String(commands[0][1]).endsWith(":spend")
    ? real(commands).then((out) => [[...((out as unknown[])[0] as string[]), "deadbeef", "{"]])
    : null;

const render = (data: StatsData, spends: unknown[], unread: StudioRead["unread"]) =>
  renderToStaticMarkup(createElement(StatsPanel, { data, canExport: false, askHeard: false, spends, spendsUnread: unread } as never));
const SPEND_FIGURES = ["What remains after refunds and ads", "Ad spend recorded", "Daily result after refunds and ads"];
const NOTICE = "Ad spend could not be read in full just now";

test("the studio reads spend with what is unread said: healthy, Meta unread, typed unread", async () => {
  const { statsId } = await fixture;
  assert.equal(typeof spendsForStudio, "function", "spendsForStudio exists");
  const healthy = await spendsForStudio!(statsId);
  assert.deepEqual([healthy.spends.map((s) => s.cents).sort(), healthy.unread], [[1200, 500], null]);
  const meta = await withPipeline(metaUnreadable, () => spendsForStudio!(statsId));
  assert.deepEqual([meta.spends.map((s) => [s.source ?? "typed", s.cents]), meta.unread], [[["typed", 1200]], "meta"]);
  const typed = await withPipeline(typedUnreadable, () => spendsForStudio!(statsId));
  assert.deepEqual([typed.spends, typed.unread], [[], "typed"]);
});

test("control: with every line read, the figures after ads are shown with the spend", async () => {
  const { data } = await fixture;
  const html = render(data, [{ id: "abcdef01", channel: "instagram", campaign: "", cents: 1200, from: today, to: today }], null);
  for (const figure of SPEND_FIGURES) assert.equal(html.includes(figure), true, figure);
  assert.equal(html.includes(NOTICE), false);
});

for (const unread of ["meta", "typed"] as const) {
  test(`with ${unread === "meta" ? "Meta's lines" : "a typed entry"} unread, no figure that uses ad spend is shown, and the page says why`, async () => {
    const { data } = await fixture;
    const html = render(data, unread === "meta" ? [{ id: "abcdef01", channel: "instagram", campaign: "", cents: 1200, from: today, to: today }] : [], unread);
    for (const figure of SPEND_FIGURES) assert.equal(html.includes(figure), false, figure);
    assert.equal(html.includes(NOTICE), true, "the notice");
  });
}

test("the studio page reads spend through spendsForStudio and hands the panel what is unread", () => {
  const page = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
  assert.equal(/readSpends\([^)]*\)\.catch\(\(\) => \[\]\)/.test(page), false, "never an unread spend as $0");
  assert.equal(page.includes("spendsForStudio(current.statsId)"), true);
  assert.equal(/spendsUnread=\{/.test(page), true);
});
