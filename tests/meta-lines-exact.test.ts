/**
 * CX-123 rule 24: what a store's Meta ad account spent is read exactly. Before, metaLines answered an unknown EXISTS
 * or lines reply as "no lines" and readSpends swallowed any failure of it, so the profit figures, the numbers the
 * model is handed and the spend editor's answers silently left Meta's spend out, as if it were zero. Now metaLines
 * throws on an unknown reply, readSpendLines says the Meta part is unread, the routes answer `spendsUnread: true`
 * with the typed lines, and the model is told ad spend is unknown. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { metaLines } from "@/lib/meta-ads";
import { addSpend, readSpends } from "@/lib/ad-spend";
import { askNumbers } from "@/lib/numbers-ask";
import type { StatsData } from "@/lib/stats";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as spendRoute } from "@/app/api/store/spend/route";
import { POST as metaAdsRoute } from "@/app/api/store/meta-ads/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = "meta-app-secret-for-tests-0123456789";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";

const prompts: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    prompts.push((JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages[0].content);
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ answer: "Fine.", used: [], window: "d30", section: "" }) }] }));
  }
  return new Response("{}", { status: 500 });
}) as typeof fetch;

const today = new Date().toISOString().slice(0, 10);
const OWNER = "meta-lines-owner@example.com";
const connKey = (statsId: string) => `nl:metaads:conn:${statsId}`;
const linesKey = (statsId: string) => `nl:stats:${statsId}:spend:meta`;
const META_LINE = { id: "meta-0123456789ab", channel: "facebook", campaign: "", cents: 500, from: today, to: today };

const fixture = (async () => {
  redis.clear();
  await claimHandle(OWNER, "meta-lines-shop", "Meta Lines Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_MetaLines01", subscriptionId: "sub_MetaLines01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const added = await addSpend(statsId, { channel: "instagram", campaign: "", cents: 1200, from: today, to: today });
  assert.equal(added.ok, true);
  redis.run(["SET", connKey(statsId), JSON.stringify({ user: "10150000000000009", token: "sealed", accounts: [{ id: "act_111", name: "Harbor Ads", currency: "usd" }, { id: "act_222", name: "Other", currency: "usd" }], account: "act_111", sid: store.sid, owner: { email: OWNER, handle: store.handle } })]);
  redis.run(["SET", linesKey(statsId), JSON.stringify([META_LINE])]);
  return { store, statsId, cookie: `${SESSION_COOKIE}=${await openSession(OWNER)}` };
})();

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** The Meta lines' read (EXISTS of the connection, GET of the lines) is answered with `reply` while `run` runs. */
async function withMetaRead<T>(reply: unknown, run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Command[]) =>
    commands[0]?.[0] === "EXISTS" && String(commands[0][1]).startsWith("nl:metaads:conn:") ? reply : real(commands)) as typeof redis.pipeline;
  try { return await run(); }
  finally { redis.pipeline = real; }
}

const UNKNOWN: [string, unknown][] = [
  ["a missing envelope", []],
  ["a connection count that is not a count", ["1", JSON.stringify([META_LINE])]],
  ["a null connection count", [null, JSON.stringify([META_LINE])]],
  ["lines that are not text", [1, 42]],
  ["lines that are not JSON", [1, "{"]],
  ["lines that are not a list", [1, "{\"a\":1}"]],
];

for (const [label, reply] of UNKNOWN) {
  test(`metaLines: ${label} is unknown, never "no lines"`, async () => {
    const { statsId } = await fixture;
    await withMetaRead(reply, () => assert.rejects(() => metaLines(statsId)));
  });
}

test("the spend route answers the typed lines with spendsUnread when Meta's lines cannot be read", async () => {
  const { cookie } = await fixture;
  const response = await withMetaRead([null, null], () =>
    spendRoute(new NextRequest("https://marktmorgen.com/api/store/spend", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "remove", id: "deadbeef" }) })),
  );
  const answer = (await response.json()) as { ok?: boolean; spends?: { source?: string; cents: number }[]; spendsUnread?: boolean };
  assert.equal(answer.ok, true);
  assert.equal(answer.spendsUnread, true);
  assert.deepEqual(answer.spends?.map((s) => [s.source ?? "typed", s.cents]), [["typed", 1200]]);
});

test("the Meta account route answers spendsUnread when Meta's lines cannot be read", async () => {
  const { cookie, store } = await fixture;
  const response = await withMetaRead([null, null], () =>
    metaAdsRoute(new NextRequest("https://marktmorgen.com/api/store/meta-ads", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "account", id: "act_111", store: store.sid }) })),
  );
  const answer = (await response.json()) as { ok?: boolean; spendsUnread?: boolean };
  assert.equal(answer.ok, true);
  assert.equal(answer.spendsUnread, true);
});

const days = Array.from({ length: 90 }, (_, i) => ({ date: new Date(Date.now() - (89 - i) * 86_400_000).toISOString().slice(0, 10), visitors: 0, views: 0, checkouts: 0, sales: 0, cents: 0 }));
const zero = { visitors: 0, views: 0, checkouts: 0, sales: 0, cents: 0 };
const data = {
  currency: "usd", sales: "ok", days,
  totals: { d7: zero, d30: zero, d90: zero, all: zero }, previous: null,
  channels: { d7: [], d30: [], d90: [] }, products: [], posts: { d7: [], d30: [], d90: [] }, ads: { d7: [], d30: [], d90: [] },
  countries: { d7: [], d30: [], d90: [], all: [] }, devices: { d7: [], d30: [], d90: [], all: [] }, renewals: null,
  buyers: { d7: { buyers: 0, orders: 0, cents: 0, returning: 0, repeat: 0 }, d30: { buyers: 0, orders: 0, cents: 0, returning: 0, repeat: 0 }, d90: { buyers: 0, orders: 0, cents: 0, returning: 0, repeat: 0 } },
  searchMisses: { d7: [], d30: [], d90: [] }, topBuyers: [],
} as unknown as StatsData;

test("the model is told ad spend is unknown, not given the typed lines as all of it, when Meta's lines cannot be read", async () => {
  const { store } = await fixture;
  await withMetaRead([null, null], () => askNumbers(store, "What did ads cost?", data));
  assert.equal(prompts.at(-1)?.includes('"untagged_ad_spend":null'), true);
});

test("healthy controls: typed and Meta lines both counted everywhere", async () => {
  const { store, statsId, cookie } = await fixture;
  assert.deepEqual((await metaLines(statsId)).map((l) => l.cents), [500]);
  assert.deepEqual((await readSpends(statsId)).map((s) => s.cents).sort(), [1200, 500]);
  await askNumbers(store, "What did ads cost?", data);
  assert.equal(prompts.at(-1)?.includes('"untagged_ad_spend":"$17'), true);
  const response = await spendRoute(new NextRequest("https://marktmorgen.com/api/store/spend", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "remove", id: "deadbeef" }) }));
  const answer = (await response.json()) as { spends?: unknown[]; spendsUnread?: boolean };
  assert.equal(answer.spends?.length, 2);
  assert.notEqual(answer.spendsUnread, true);
});

test("confirmed absence: not connected, or connected with nothing read yet, is no Meta line", async () => {
  const { statsId } = await fixture;
  await withMetaRead([0, null], async () => assert.deepEqual(await metaLines(statsId), []));
  await withMetaRead([1, null], async () => assert.deepEqual(await metaLines(statsId), []));
});

// Codex Z on #2924: a list or a hash whose envelope is right but holds a member in another shape is not read whole.
// Dropping that member silently left the rest standing as all of the spend; now the whole read is unknown.
const BAD_LINES: [string, unknown][] = [
  ["a line with no id", { channel: "facebook", campaign: "", cents: 300, from: today, to: today }],
  ["a line whose id is not Meta's", { ...META_LINE, id: "typed-01" }],
  ["a line of no amount", { ...META_LINE, id: "meta-ffffffffffff", cents: 0 }],
  ["text", "junk"],
  ["null", null],
];
for (const [label, member] of BAD_LINES) {
  test(`metaLines: a kept list holding ${label} beside a whole line is unknown, never that line alone`, async () => {
    const { statsId } = await fixture;
    await withMetaRead([1, JSON.stringify([META_LINE, member])], () => assert.rejects(() => metaLines(statsId)));
  });
}

test("the model is told ad spend is unknown when a Meta line is in another shape, never handed the rest as all of it", async () => {
  const { store } = await fixture;
  await withMetaRead([1, JSON.stringify([META_LINE, "junk"])], () => askNumbers(store, "What did ads cost?", data));
  assert.equal(prompts.at(-1)?.includes('"untagged_ad_spend":null'), true);
});

/** The typed lines' HGETALL answered with what is kept plus `extra` (field, value pairs) while `run` runs. */
async function withTypedExtra<T>(extra: string[], run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => {
    const out = await real(commands);
    return commands.length === 1 && commands[0][0] === "HGETALL" && String(commands[0][1]).endsWith(":spend") ? [[...(out[0] as string[]), ...extra]] : out;
  }) as typeof redis.pipeline;
  try { return await run(); }
  finally { redis.pipeline = real; }
}

const BAD_TYPED: [string, string[]][] = [
  ["a field that is not an id", ["not-an-id", JSON.stringify({ channel: "podcast", campaign: "", cents: 900, from: today, to: today })]],
  ["a value that is not JSON", ["abcdef01", "{"]],
  ["a value that is not a record", ["abcdef02", "7"]],
  ["a record of no channel", ["abcdef03", JSON.stringify({ channel: "", campaign: "", cents: 900, from: today, to: today })]],
];
for (const [label, extra] of BAD_TYPED) {
  test(`typed spend holding ${label} beside a whole entry is unknown, never that entry alone`, async () => {
    const { statsId } = await fixture;
    await withTypedExtra(extra, () => assert.rejects(() => readSpends(statsId)));
  });
}

test("the model is told ad spend is unknown when a typed entry is in another shape", async () => {
  const { store } = await fixture;
  await withTypedExtra(["abcdef01", "{"], () => askNumbers(store, "What did ads cost?", data));
  assert.equal(prompts.at(-1)?.includes('"untagged_ad_spend":null'), true);
});

test("the spend route answers 503 when a typed entry is in another shape, never the rest as all of it", async () => {
  const { cookie } = await fixture;
  const response = await withTypedExtra(["abcdef01", "{"], () =>
    spendRoute(new NextRequest("https://marktmorgen.com/api/store/spend", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "remove", id: "deadbeef" }) })),
  );
  assert.equal(response.status, 503);
});
