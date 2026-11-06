/**
 * Counts that decide whether something may go ahead are read exactly (CX-123
 * rule 24). A reply that is not Redis's own count is never 0, so it never lets
 * through what the count would have stopped:
 *
 *   - a running series of calls (lib/call-series-open.ts, runningSeries): the
 *     currency and sales-tax routes answer 503 instead of changing the store's
 *     currency, or switching tax on, under a series charged in the old terms;
 *   - the emails already used this month (lib/mail.ts): a broadcast is not
 *     written as if the month were untouched;
 *   - the stores that pay (lib/free-pool.ts): a free store is not turned away
 *     for an hour on a pool sized as if nobody paid; its count is given back;
 *   - the bonds a store keeps (lib/affiliate-bond.ts): no new bond is written
 *     past a cap that could not be read.
 *
 * Each with a healthy control and a confirmed absence, on synthetic data.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setProductCall, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import type { CallSetup } from "@/lib/call-setup";
import { markSeriesOpen, runningSeries, seriesOpenKey } from "@/lib/call-series-open";
import { POST as currencyRoute } from "@/app/api/store/currency/route";
import { POST as taxRoute } from "@/app/api/store/tax/route";
import { upsertContact } from "@/lib/contacts";
import { createBroadcast } from "@/lib/broadcasts";
import { calendarWindow, windowId } from "@/lib/allowance-window";
import { poolPlace } from "@/lib/free-pool";
import { FREE_POOL_BASE_STORES, PAID_STORES_PER_FREE_STORE, PAYING_INDEX } from "@/lib/free-pool-rules";
import { bondFor, rememberBuyer } from "@/lib/affiliate-bond";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

/** Runs `run` with the reply of every command matching `match` replaced by `reply`; every command still runs. */
async function replacing<T>(match: (c: Command) => boolean, reply: unknown, run: () => Promise<T>, drop = false): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => {
    const got = (await real(commands)) as unknown[];
    if (drop && commands.some(match)) return got.slice(0, -1);
    return got.map((r, i) => (match(commands[i]) ? reply : r));
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real as typeof redis.pipeline;
  }
}

/** A count's replies that are not a count. */
const BAD: [string, unknown][] = [
  ["text '0'", "0"],
  ["null", null],
  ["negative", -1],
  ["fraction", 0.5],
  ["object", {}],
];

const weekly = {
  kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [], [], [], [], []],
  noticeHours: 12, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;

const seriesFixture = (async () => {
  redis.clear();
  const owner = "num-gates-series@example.com";
  await claimHandle(owner, "numgatesseries", "Fictional Series", "");
  await ensureStoreId(owner);
  const call = await addProduct(owner, "Fictional Call", "", "80", null);
  if (!call.ok) throw new Error("no product");
  assert.equal((await setProductCall(owner, call.product.id, weekly)).ok, true);
  const store = (await storeForEmail(owner))!;
  const session = await openSession(owner);
  const send = async (route: typeof currencyRoute, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; running?: number } };
  };
  return { owner, store, diary: { ...store, callsId: store.callsId! }, send };
})();

const isZcount = (key: string) => (c: Command) => c[0] === "ZCOUNT" && c[1] === key;

test("a running series: an unknown count throws, never 0", async () => {
  const { store, diary } = await seriesFixture;
  await markSeriesOpen(diary, "a".repeat(32), Date.now() + 7 * 86_400_000);
  assert.equal(await runningSeries(store), 1, "healthy: the series is counted");
  for (const [label, reply] of BAD) {
    await assert.rejects(() => replacing(isZcount(seriesOpenKey(diary.callsId)), reply, () => runningSeries(store)), `${label}`);
  }
  await assert.rejects(() => replacing(isZcount(seriesOpenKey(diary.callsId)), 1, () => runningSeries(store), true), "no reply");
  assert.equal(await runningSeries({ callsId: "0".repeat(24) }), 0, "confirmed absence: a diary with no series has none");
});

test("the currency and tax routes answer 503 on an unknown series count, and change nothing", async () => {
  const { owner, diary, send } = await seriesFixture;
  for (const [label, reply] of BAD) {
    const currency = await replacing(isZcount(seriesOpenKey(diary.callsId)), reply, () => send(currencyRoute, "currency", { currency: "eur", confirm: true }));
    assert.deepEqual([currency.status, currency.body.ok, currency.body.error], [503, false, "unavailable"], `currency, ${label}`);
    assert.equal((await storeForEmail(owner))!.currency, "usd", `the currency stays, ${label}`);
    const tax = await replacing(isZcount(seriesOpenKey(diary.callsId)), reply, () => send(taxRoute, "tax", { enabled: true, included: false, ids: false, invoices: false }));
    assert.deepEqual([tax.status, tax.body.ok, tax.body.error], [503, false, "unavailable"], `tax, ${label}`);
    assert.equal((await storeForEmail(owner))!.tax.enabled, false, `tax stays off, ${label}`);
  }
  // Healthy control: a series that runs is still refused with its count.
  const refused = await send(currencyRoute, "currency", { currency: "eur", confirm: true });
  assert.deepEqual([refused.status, refused.body.error, refused.body.running], [409, "series", 1]);
});

test("a broadcast: an unknown count of the month's emails is never an untouched month", async () => {
  redis.clear();
  const owner = "num-gates-mail@example.com";
  const made = await claimHandle(owner, "numgatesmail", "Fictional Mail", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_NumGates001", subscriptionId: "sub_NumGates001", active: true, tier: "scale", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Fictional Mail", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(owner))!;
  for (let i = 0; i < 3; i += 1) await upsertContact(store.listId as string, `reader${i}@example.test`, { agreed: true, explicit: true, source: "free" }, ROOM);
  const usedKey = `nl:mail:used:${store.listId}:${windowId(store)}`;
  const send = () => createBroadcast(store, { subject: "Fictional news", body: "It is ready.", productId: "", notProductId: "", sendAt: undefined });
  const isUsed = (c: Command) => c[0] === "GET" && c[1] === usedKey;
  // GET answers a counter as its text ("0", "12", "-3" after a give-back), or nil before the first: anything else is unknown.
  for (const [label, reply] of [["a number, not text", 5], ["negative number", -1], ["fraction", 0.5], ["object", {}], ["digits with a plus", "+5"], ["text with a space", " 5"], ["a word", "five"]] as [string, unknown][]) {
    await assert.rejects(() => replacing(isUsed, reply, send), `${label}`);
    assert.equal(redis.keys().some((k) => k.startsWith("nl:mail:bc")), false, `nothing written, ${label}`);
  }
  // Confirmed absence: nothing used yet this month.
  const fresh = await send();
  assert.equal(fresh.ok, true, "nothing used: the broadcast is written");
  // Healthy: the count as Redis keeps it (INCRBY's text), so a full month still refuses.
  redis.run(["SET", usedKey, String(10 ** 9)]);
  const full = await send();
  assert.equal(full.ok ? "made" : full.reason, "allowance");
});

test("the free pool: an unknown count of paying stores never turns a store away, and gives its count back", async () => {
  redis.clear();
  const now = Date.now();
  const month = calendarWindow(now).id;
  const countKey = `nl:free:n:${month}`;
  const free = (n: number) => ({ sid: `numgates${n}`.padEnd(32, "q"), handle: `numgates${n}`, statsId: null, tier: "creator" as const, subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "" });
  const inKey = (sid: string) => `nl:free:in:${month}:${createHash("sha256").update(`free-pool:${sid}`).digest("hex").slice(0, 32)}`;
  // The base places are taken; enough stores pay for one more.
  for (let i = 0; i < PAID_STORES_PER_FREE_STORE; i += 1) redis.run(["SADD", PAYING_INDEX, `paying${i}`]);
  redis.run(["SET", countKey, String(FREE_POOL_BASE_STORES)]);
  const isPaying = (c: Command) => c[0] === "SCARD" && c[1] === PAYING_INDEX;
  let n = 0;
  for (const [label, reply] of BAD) {
    const store = free((n += 1));
    assert.equal(await replacing(isPaying, reply, () => poolPlace(store, now)), "unknown", label);
    assert.equal(redis.run(["GET", countKey]), String(FREE_POOL_BASE_STORES), `the count is given back, ${label}`);
    assert.equal(redis.run(["GET", inKey(store.sid)]), null, `no refusal written, ${label}`);
  }
  // Healthy: the place paid for by the paying stores is handed out.
  assert.equal(await poolPlace(free((n += 1)), now), "in");
  // And past it, a known count turns the next store away.
  assert.equal(await poolPlace(free((n += 1)), now), "full");
});

test("the affiliate bond: no new bond is written past a cap that could not be read", async () => {
  redis.clear();
  const store = { handle: "numgatesbond", name: "Fictional Bonds", statsId: "st_num_gates_bond", affiliates: parseAffiliateSetting({ enabled: true, percent: 20, days: 30, lifetime: true }) } as unknown as Store;
  const ANA = "a1b2c3d4e5f6";
  const key = "nl:aff:st_num_gates_bond:bond";
  let n = 0;
  for (const [label, reply] of BAD) {
    const email = `buyer${(n += 1)}@example.test`;
    await replacing((c) => c[0] === "HLEN" && c[1] === key, reply, () => rememberBuyer(store, email, ANA, "last"));
    assert.equal(await bondFor(store, email), "", `the cap unknown (${label}): no bond written`);
  }
  for (const [label, reply] of [["2", 2], ["text '0'", "0"], ["null", null]] as [string, unknown][]) {
    const email = `known${(n += 1)}@example.test`;
    await replacing((c) => c[0] === "HEXISTS" && c[1] === key, reply, () => rememberBuyer(store, email, ANA, "last"));
    assert.equal(await bondFor(store, email), "", `whether the buyer is known unknown (${label}): no bond written`);
  }
  // Healthy and confirmed absence: a new buyer under the cap is bonded.
  await rememberBuyer(store, "healthy@example.test", ANA, "last");
  assert.equal(await bondFor(store, "healthy@example.test"), ANA);
});
