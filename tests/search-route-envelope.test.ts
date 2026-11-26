/**
 * The whole request that reaches the writer #5010 row 130 turned into a store-live fence (lib/store-live-cache.ts
 * setWhileStoreLive: one EVAL of SET_IF_STORE_LIVE, its HGET, GET and SET billed beside it, in place of one plain SET),
 * measured at its worst against the priced envelope of its scope: the store page's search building its index
 * (app/[handle]/page.tsx, searchStorePaid, buildIndex) is a public page; every public request it takes (the page's
 * own, the kept index's read and the build's shared units) is priced as a later page (tests/traffic-cost.ts,
 * COMMANDS.laterPage + COMMANDS.laterCount).
 * Upstash bills a script as one command plus each redis.call it runs. The stand-in runs SET_IF_STORE_LIVE beside the
 * stub (tests/redis-take-scripts.ts) without counting its calls, so each of its EVALs is billed here at its worst run
 * (STORE_LIVE_CALLS); every other script's calls are those the stub counts (scriptCalls).
 * Synthetic stores; in-memory Redis; no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import StorePage from "@/app/[handle]/page";
import { STORE_PAGE_SIZE } from "@/lib/catalog";
import { listingsToRead } from "@/lib/catalog-read-count";
import { SET_IF_STORE_LIVE } from "@/lib/live-fence";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { searchIndexKey } from "@/lib/store-search-index";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { answering } from "./security/next-headers";
import { COMMANDS } from "./traffic-cost";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

type Command = (string | number)[];
const LATER_PAGE = COMMANDS.laterPage + COMMANDS.laterCount;
/** SET_IF_STORE_LIVE's worst run: the erasing HGET, one GET of the live key (either branch), the SET. */
const STORE_LIVE_CALLS = 3;
assert.equal((SET_IF_STORE_LIVE.match(/redis\.call\(/g) ?? []).length, 4, "SET_IF_STORE_LIVE: HGET, a GET on each of its two exclusive branches, SET");

/** Runs `work` and bills every command it sends, as Upstash would. */
async function billed<T>(work: () => Promise<T>): Promise<{ result: T; commands: number; external: number; scriptCalls: number; fences: number; evals: string[] }> {
  const original = redis.pipeline;
  const sent: Command[] = [];
  const before = redis.scriptCalls;
  redis.pipeline = async (batch: Command[]) => { sent.push(...batch); return original.call(redis, batch); };
  try {
    const result = await work();
    const evals = sent.filter((c) => c[0] === "EVAL").map((c) => /^-- marktmorgen:([a-z0-9-]+:v\d+)/.exec(String(c[1]))?.[1] ?? "?");
    const fences = evals.filter((name) => name.startsWith("store-cache-live:")).length;
    const scriptCalls = redis.scriptCalls - before;
    return { result, commands: sent.length + scriptCalls + fences * STORE_LIVE_CALLS, external: sent.length, scriptCalls, fences, evals };
  } finally {
    redis.pipeline = original;
  }
}

/** Every public request the store's windows have counted so far. */
function requestsTaken(): number {
  return redis.keys().filter((key: string) => key.startsWith("nl:traffic:r:")).reduce((sum: number, key: string) => sum + Number(redis.run(["GET", key]) ?? 0), 0);
}

async function searchStore(extra: number) {
  redis.clear();
  const owner = `search-envelope-${extra}@example.test`;
  const handle = `searchenv${extra}`;
  await claimHandle(owner, handle, "Search Envelope", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_searchenv01", subscriptionId: "sub_searchenv01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  for (let n = 1; n <= STORE_PAGE_SIZE + extra; n += 1) {
    const made = await addProduct(owner, `Lesson ${n}`, "A synthetic lesson.", "9", null);
    if (!made.ok) throw new Error(`no product ${n}`);
  }
  return { store: (await storeForEmail(owner))!, handle };
}

async function drawSearch(handle: string, query: string) {
  const params = { q: query };
  answering(new NextRequest(`https://marktmorgen.com/@${handle}?q=${encodeURIComponent(query)}`, { headers: { "x-forwarded-for": "203.0.113.9" } }));
  const element = await StorePage({ params: Promise.resolve({ handle: `@${handle}` }), searchParams: Promise.resolve(params) } as never);
  const stream = await renderToReadableStream(element as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

// Row 130. The fewest listings past the record (one unit of shared work for the build) and many more.
for (const extra of [1, 100]) {
  test(`the store page's search that builds its index (${extra} listing(s) past the record) fits the public requests it takes`, async () => {
    const { store, handle } = await searchStore(extra);
    assert.ok(listingsToRead(store) > 0, "the search reads listings, so it builds and keeps an index");
    assert.equal(Number(redis.run(["EXISTS", searchIndexKey(store)])), 0, "no kept index: the build and its write happen (worst case)");
    const taken0 = requestsTaken();
    const run = await billed(() => drawSearch(handle, "lesson"));
    const taken = requestsTaken() - taken0;
    assert.ok(run.result.includes(`Lesson ${STORE_PAGE_SIZE + 1}`), "the search found a listing past the record");
    assert.equal(Number(redis.run(["EXISTS", searchIndexKey(store)])), 1, "and kept the index");
    const envelope = taken * LATER_PAGE;
    console.log("SEARCH_BUILD_PAGE", JSON.stringify({ extra, external: run.external, scriptCalls: run.scriptCalls, fences: run.fences, fenceCalls: run.fences * STORE_LIVE_CALLS, measured: run.commands, publicRequestsTaken: taken, laterPage: LATER_PAGE, envelopeCommands: envelope, evals: run.evals }));
    assert.equal(run.fences, 1, "one fenced write of the index");
    assert.ok(run.commands <= envelope, `${run.commands} commands within ${taken} public requests of ${LATER_PAGE}`);
  });
}
