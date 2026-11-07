/**
 * Independent financial review proof for PR #2924 at
 * d8a16b21ba1022e5b603b6f20f39a2619e889317.
 *
 * A paid spend read is complete only when every member of the provider value
 * is understood. These cases inject one valid and one malformed member into
 * each Redis value. The valid-only control passes. The five causal cases
 * fail on the reviewed head because the malformed members are silently
 * discarded and the remaining $17 is presented as the whole known cost.
 * Synthetic data only; no provider is contacted.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { UnknownReplyError } from "@/lib/redis-reply";
import { readSpendLines } from "@/lib/ad-spend";
import { dailyCashflowRows } from "@/lib/daily-cashflow";
import { metaLines } from "@/lib/meta-ads";
import { askNumbers, weeklySummary } from "@/lib/numbers-ask";
import type { StatsData } from "@/lib/stats";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";

const today = new Date().toISOString().slice(0, 10);
const owner = "z2924-proof-owner@example.com";
const typedKey = (statsId: string) => `nl:stats:${statsId}:spend`;
const connectionKey = (statsId: string) => `nl:metaads:conn:${statsId}`;
const metaKey = (statsId: string) => `nl:stats:${statsId}:spend:meta`;
const typed = { channel: "instagram", campaign: "", cents: 1200, from: today, to: today };
const meta = { id: "meta-0123456789ab", channel: "facebook", campaign: "", cents: 500, from: today, to: today };

const prompts: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") return new Response("{}", { status: 500 });
  const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
  prompts.push(body.messages[0].content);
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ answer: "Synthetic answer.", used: [], window: "d30", section: "" }) }] }));
}) as typeof fetch;

const fixture = (async () => {
  redis.clear();
  await claimHandle(owner, "z2924-proof-shop", "Z2924 Proof Shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, {
    customerId: "cus_Z2924Proof",
    subscriptionId: "sub_Z2924Proof",
    active: true,
    tier: "pro",
    period: paidPeriod(),
  });
  const shop = await storeForEmail(owner);
  assert.ok(shop?.statsId);
  return { shop, statsId: shop.statsId };
})();

function putSpendValues(statsId: string, malformed: { typed: boolean; meta: boolean }): void {
  redis.run(["DEL", typedKey(statsId), connectionKey(statsId), metaKey(statsId)]);
  redis.run([
    "HSET",
    typedKey(statsId),
    "01234567",
    JSON.stringify(typed),
    ...(malformed.typed ? ["89abcdef", "{"] : []),
  ]);
  redis.run(["SET", connectionKey(statsId), "connected"]);
  redis.run(["SET", metaKey(statsId), JSON.stringify(malformed.meta ? [meta, "malformed Meta member"] : [meta])]);
}

const zero = { visitors: 0, views: 0, checkouts: 0, sales: 0, cents: 0 };
const data = {
  currency: "usd",
  sales: "ok",
  paymentsComplete: true,
  cashflowComplete: true,
  days: [{ date: today, visitors: 0, views: 0, checkouts: 0, sales: 1, cents: 3000 }],
  channelDays: { instagram: { [today]: 3000 } },
  refundDays: { [today]: 0 },
  refunds: { d7: [], d30: [], d90: [] },
  totals: { d7: { ...zero, sales: 1, cents: 3000 }, d30: { ...zero, sales: 1, cents: 3000 }, d90: { ...zero, sales: 1, cents: 3000 }, all: zero },
  previous: null,
  channels: { d7: [], d30: [], d90: [] },
  products: [],
  posts: { d7: [], d30: [], d90: [] },
  ads: { d7: [], d30: [], d90: [] },
  countries: { d7: [], d30: [], d90: [], all: [] },
  devices: { d7: [], d30: [], d90: [], all: [] },
  renewals: null,
  buyers: { d7: { buyers: 1, orders: 1, cents: 3000, returning: 0, repeat: 0 }, d30: { buyers: 1, orders: 1, cents: 3000, returning: 0, repeat: 0 }, d90: { buyers: 1, orders: 1, cents: 3000, returning: 0, repeat: 0 } },
  searchMisses: { d7: [], d30: [], d90: [] },
  topBuyers: [],
} as unknown as StatsData;

test("control: wholly valid typed and Meta members produce the known $17 cost", async () => {
  const { statsId } = await fixture;
  putSpendValues(statsId, { typed: false, meta: false });
  const read = await readSpendLines(statsId);
  assert.equal(read.metaUnread, false);
  assert.deepEqual(read.spends.map((line) => line.cents).sort((a, b) => a - b), [500, 1200]);
});

test("Meta read rejects the whole list when any member is malformed", async () => {
  const { statsId } = await fixture;
  putSpendValues(statsId, { typed: false, meta: true });
  await assert.rejects(() => metaLines(statsId));
});

test("typed spend read rejects the whole hash when any field value is malformed", async () => {
  const { statsId } = await fixture;
  putSpendValues(statsId, { typed: true, meta: false });
  await assert.rejects(() => readSpendLines(statsId));
});

test("partial provider values leave daily ad cost and after-ads result unknown", async () => {
  const { statsId } = await fixture;
  putSpendValues(statsId, { typed: true, meta: true });
  const read = await readSpendLines(statsId).catch((error: unknown) => {
    if (error instanceof UnknownReplyError) return null;
    throw error;
  });
  const row = dailyCashflowRows(data, "d7", read && !read.metaUnread ? read.spends : undefined)[0];
  assert.deepEqual([row.ads, row.afterAds], [null, null]);
});

test("askNumbers does not hand the partial $17 to the model as all ad spend", async () => {
  const { shop, statsId } = await fixture;
  putSpendValues(statsId, { typed: true, meta: true });
  await askNumbers(shop, "What did ads cost?", data);
  assert.equal(prompts.at(-1)?.includes('"untagged_ad_spend":null'), true);
});

test("weeklySummary does not hand the partial $17 to the model as all ad spend", async () => {
  const { shop, statsId } = await fixture;
  putSpendValues(statsId, { typed: true, meta: true });
  await weeklySummary(shop, data);
  assert.equal(prompts.at(-1)?.includes('"untagged_ad_spend":null'), true);
});
