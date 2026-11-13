/**
 * Ad spend that could not be read is shown as not read, never as no spend (review of #4027, Claude 3, MEDIUM 2).
 *
 * #4027 made readSpends throw when the Meta lines cannot be read, but the studio's numbers (app/studio/page.tsx) and
 * the weekly email (app/api/cron/weekly) still caught it as an empty list: the studio then showed "Ad spend recorded
 * $0.00" and "After refunds and ads" as receipts less refunds, a return on ads higher than it was. Now an unread spend
 * reaches them as not read: the studio's figures after ads read "—" with a line saying why, and the weekly email says
 * the spend was not read instead of leaving it out silently.
 *
 * Synthetic store and figures; real MemoryRedis.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatsPanel } from "@/components/stats-panel";
import { weeklyMessage } from "@/lib/stats-report";
import { readStats, studioStats, type StatsData } from "@/lib/stats";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const OWNER = "spend-unread@example.com";
const UNREAD = "Ad spend could not be read just now";

function sources(dir: string): string[] {
  return readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

async function figures(): Promise<{ data: StatsData; store: NonNullable<Awaited<ReturnType<typeof storeForEmail>>> }> {
  await claimHandle(OWNER, "spend-unread", "Spend Unread", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const stats = await readStats(store, Date.UTC(2026, 9, 14));
  if (!stats) throw new Error("no stats");
  const base = studioStats(store, stats, null, "none", []);
  const totals = { visitors: 50, views: 100, checkouts: 10, sales: 2, cents: 10_000 };
  const data = {
    ...base,
    sales: "ok",
    totals: { ...base.totals, d7: totals, all: totals },
    channels: { ...base.channels, d7: [{ source: "google", visits: 50, checkouts: 10, free: 0, sales: 2, cents: 10_000 }] },
  } as StatsData;
  return { data, store };
}

test("no reader of ad spend takes an unread spend for none", () => {
  const swallowed = [...sources("app"), ...sources("lib")].filter((path) => /readSpends\([^)]*\)\.catch\(\(\) => \[\]\)/.test(readFileSync(join(process.cwd(), path), "utf8")));
  assert.deepEqual(swallowed, []);
});

test("the studio's numbers show an unread spend as not read, never $0.00", async () => {
  const { data } = await figures();
  const html = renderToStaticMarkup(createElement(StatsPanel, { data, canExport: false, askHeard: false, spends: null }));
  assert.ok(html.includes(UNREAD), "says the spend was not read");
  const tile = html.slice(html.indexOf(">Ad spend recorded<"), html.indexOf(">Ad spend recorded<") + 200);
  assert.ok(html.includes(">Ad spend recorded<"), "the payments tiles are still shown");
  assert.ok(!/\$0\.00/.test(tile), "no spend of $0.00 is claimed");
  // Control: a spend read as none is said as none.
  const none = renderToStaticMarkup(createElement(StatsPanel, { data, canExport: false, askHeard: false, spends: [] }));
  assert.ok(!none.includes(UNREAD));
});

test("the weekly email says an unread spend was not read", async () => {
  const { data, store } = await figures();
  const unread = weeklyMessage(store, data, "https://marktmorgen.com/stop", null);
  assert.ok(unread?.text.includes("Ad spend could not be read"), "the email says so");
  const read = weeklyMessage(store, data, "https://marktmorgen.com/stop", []);
  assert.ok(!read?.text.includes("Ad spend could not be read"));
});
