/**
 * Store addresses that lead nowhere, and ids that lead nowhere in a real store (traffic audit of 9 November 2026,
 * MÉDIO 2, and its pre-review the same day). Every page and route under app/[handle] first looks the address up in the
 * database; without a store there is no window to count it in. A made-up purchase-for-several id on a real store's
 * page read the database before anything counted the request.
 *
 * Held here: whether a store is there is decided by the address's index read on every request, so a real store is
 * never paced and costs what storeForHandle costs; only an address whose index names nobody counts against the asking
 * connection's pace, and past it a route answers 429 with Retry-After; a made-up address never reads a store's record
 * and counts nothing in the database; and a real store's group page counts the request in the store's own window
 * before it reads the group. What a made-up address costs is priced per request below, with no company ceiling
 * claimed (docs/funded-exposure-review.md).
 */
import StorePage, { generateMetadata as storeMeta } from "@/app/[handle]/page";
import { GET as feed } from "@/app/[handle]/blog/feed.xml/route";
import { GET as manifest } from "@/app/[handle]/manifest.webmanifest/route";
import GroupPage from "@/app/[handle]/group/[group]/page";
import { claimHandle, ensureStatsId, lookUpVisitorStore, setSubscription, storeForEmail, storeForVisitor, type Store } from "@/lib/store";
import { readFileSync, readdirSync } from "node:fs";
import { STORE_LOOKUP_RETRY_SECONDS, type StoreProbe, UNSEEN_STORE_LOOKUPS_PER_MINUTE, lookUpStore } from "@/lib/store-lookup";
import {
  UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, VERCEL_CALL_MICRO_USD_PER_MILLION,
  VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR,
} from "@/lib/spend-cost-table";
import { REDIS_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { CDN_PER_REQUEST, ORIGIN_PER_BYTE } from "./traffic-cost";
import { requestLimitFor } from "@/lib/traffic-rules";
import { takePublicRequest } from "@/lib/traffic";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

type Seen = { commands: number; counters: number; reads: string[] };

async function watched(run: () => Promise<unknown>): Promise<Seen> {
  const original = redis.pipeline.bind(redis);
  const seen: Seen = { commands: 0, counters: 0, reads: [] };
  redis.pipeline = async (cmds) => {
    seen.commands += cmds.length;
    seen.counters += cmds.filter((c) => /^(INCR|INCRBY|HINCRBY|DECR|DECRBY|EVAL|EVALSHA)$/.test(String(c[0]))).length;
    for (const c of cmds) if (String(c[0]) === "GET") seen.reads.push(String(c[1]));
    return original(cmds);
  };
  try { await run().catch(() => {}); } finally { redis.pipeline = original; }
  return seen;
}

const madeUp = (i: number) => `zz${((i * 2654435761) >>> 0).toString(36)}x${i}`;

async function main(): Promise<void> {
  redis.clear();

  part("Made-up store addresses from one connection: the index read alone, never a store's record, nothing counted");
  const N = 2_000;
  let all: Seen = { commands: 0, counters: 0, reads: [] };
  for (let i = 0; i < N; i++) {
    const handle = `@${madeUp(i)}`;
    const seen = await watched(async () => {
      await storeMeta({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) } as never).catch(() => {});
      await StorePage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) } as never).catch(() => {});
      await feed(new Request("https://marktmorgen.com/x"), { params: Promise.resolve({ handle }) }).catch(() => {});
    });
    all = { commands: all.commands + seen.commands, counters: all.counters + seen.counters, reads: [...all.reads, ...seen.reads] };
  }
  console.log(`  ${N} made-up addresses: ${all.commands} commands, ${all.counters} counted, ${all.reads.length} reads`);
  // Pre-review of 9 November 2026: the day's count (INCR/EXPIRE/DECR) was written and never read, and the pace saved
  // reads only by taking real stores off the air; neither is kept. Each lookup is one index read, as before the audit.
  is("nothing is counted in the database for them", all.counters, 0);
  is("only addresses' index reads, never a store's record", all.reads.filter((key) => !key.startsWith("nl:store:handle:")), []);
  is("at most one read for each of the page's head, the page and the feed", all.commands <= 3 * N, true);

  part("A made-up id on a real store's group page, its window used up: nothing is read for it");
  const OWNER = "groupscan@example.com";
  await claimHandle(OWNER, "groupscan", "Group Scan", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_groupscan1", subscriptionId: "sub_groupscan1", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  // Its address was visited before from another connection, so this server knows it has a store: the connection
  // above, which used its minute on made-up addresses, is not what this part is about.
  is("(setup) the store is found for a visitor", (await storeForVisitor("groupscan", { address: "203.0.113.50" }))?.handle, "groupscan");
  is("(setup) the store's whole window is taken", await takePublicRequest(store, "buyer", Date.now(), requestLimitFor(store), { shared: true }), true);
  let groupReads = 0, groupCounted = 0;
  for (let i = 0; i < 50; i++) {
    const id = `grp_${i.toString(16).padStart(24, "0")}`;
    const seen = await watched(() => GroupPage({ params: Promise.resolve({ handle: "@groupscan", group: id }), searchParams: Promise.resolve({}) } as never));
    groupReads += seen.reads.filter((key) => key.startsWith("nl:grp:")).length;
    groupCounted += seen.counters;
  }
  console.log(`  50 made-up group ids: ${groupReads} group reads, ${groupCounted} counted`);
  is("each load is counted in the store's window before the group is read", groupCounted >= 50, true);
  is("with the window used up, no group is read", groupReads, 0);

  part("The lookup itself: the index decides on every request, and only a miss is paced");
  redis.clear();
  const DAY = Date.UTC(2026, 10, 20, 12);
  let looked = 0, opened = 0;
  // A stand-in for lib/store.ts's probe: the index at test:idx:<handle>, the record at test:rec:<holder>.
  const probe = (handle: string): StoreProbe<{ handle: string }> => ({
    look: async (h) => { looked += 1; const [v] = await redis.pipeline([["GET", `test:idx:${h}`]]); return typeof v === "string" && v ? { handle: h } : null; },
    indexKey: `test:idx:${handle}`,
    holderOf: (value) => (typeof value === "string" && value ? value : null),
    open: async (holder) => { opened += 1; const [raw] = await redis.pipeline([["GET", `test:rec:${holder}`]]); return typeof raw === "string" ? { handle } : null; },
  });
  const ask = (handle: string, now: number, address: string) => lookUpStore(handle, probe(handle), { now, address });
  let answer: Awaited<ReturnType<typeof ask>> | null = null;
  const first = await watched(async () => { answer = await ask("nothere", DAY, "198.51.100.1"); });
  is("a made-up address: the index read alone, no record, nothing counted", [first.commands, first.counters, opened, looked, answer], [1, 0, 0, 0, { store: null, retryAfter: 0 }]);
  const again = await watched(() => ask("nothere", DAY + 1, "198.51.100.2"));
  is("asked again, it is read again: nothing is remembered between requests", again.commands, 1);

  redis.run(["SET", "test:idx:realshop", "owner@example.com"]);
  redis.run(["SET", "test:rec:owner@example.com", "{}"]);
  const realSeen = await watched(async () => { answer = await ask("realshop", DAY, "198.51.100.3"); });
  is("a real store: the index read, then its record, as storeForHandle reads them", [realSeen.commands, realSeen.counters, opened, answer], [2, 0, 1, { store: { handle: "realshop" }, retryAfter: 0 }]);

  part("One connection's minute: misses past the pace are told to wait; the read is never skipped, a real store opens");
  const PACE_AT = DAY + 3_600_000;
  let paced = 0, waits = 0;
  for (let i = 0; i < UNSEEN_STORE_LOOKUPS_PER_MINUTE + 10; i++) {
    const seen = await watched(async () => { answer = await ask(`pace${i}`, PACE_AT, "198.51.100.5"); });
    paced += seen.reads.length;
    if (answer!.retryAfter === STORE_LOOKUP_RETRY_SECONDS) waits += 1;
  }
  is("every miss still reads its index; those past the pace are told to wait a minute", [paced, waits], [UNSEEN_STORE_LOOKUPS_PER_MINUTE + 10, 10]);
  opened = 0;
  let served = 0;
  for (let i = 0; i < UNSEEN_STORE_LOOKUPS_PER_MINUTE * 3; i++) {
    const found = await ask("realshop", PACE_AT + 1, "198.51.100.5");
    if (found.store && !found.retryAfter) served += 1;
  }
  is("a real store opens for that connection every time, never paced", [served, opened], [UNSEEN_STORE_LOOKUPS_PER_MINUTE * 3, UNSEEN_STORE_LOOKUPS_PER_MINUTE * 3]);
  is("another connection is not told to wait for it", (await ask("pacenew", PACE_AT, "198.51.100.6")).retryAfter, 0);
  is("the minute turns", (await ask("pacelater", PACE_AT + 60_000, "198.51.100.5")).retryAfter, 0);

  part("A record read empty is not a miss: not paced, not remembered");
  opened = 0;
  redis.run(["SET", "test:idx:midclaim", "mid@example.com"]);
  let emptyWaits = 0;
  for (let i = 0; i < UNSEEN_STORE_LOOKUPS_PER_MINUTE + 5; i++) if ((await ask("midclaim", DAY + 7_200_000, "198.51.100.7")).retryAfter) emptyWaits += 1;
  redis.run(["SET", "test:rec:mid@example.com", "{}"]);
  is("never told to wait, and found the moment its record is written", [emptyWaits, (await ask("midclaim", DAY + 7_200_001, "198.51.100.7")).store?.handle], [0, "midclaim"]);

  part("A reply that cannot be read is no answer: the normal lookup decides, and it is not a miss");
  redis.clear();
  looked = 0;
  redis.run(["SET", "test:idx:realgarbled", "g@example.com"]);
  const BROKEN = DAY + 4 * 3_600_000;
  // The connection has used its minute, so a garbled reply counted as a miss would show as a wait.
  for (let i = 0; i <= UNSEEN_STORE_LOOKUPS_PER_MINUTE; i++) await ask(`used${i}`, BROKEN, "192.0.2.9");
  const original = redis.pipeline.bind(redis);
  const garble = (reply: unknown[]) => { redis.pipeline = async (cmds) => (cmds.length === 1 && String(cmds[0]![1]).startsWith("test:idx:") && cmds[0]![0] === "GET" && looked === lookedAt ? reply : original(cmds)); };
  let lookedAt = 0;
  let garbledReal: Awaited<ReturnType<typeof ask>> | null = null, garbledMade: Awaited<ReturnType<typeof ask>> | null = null;
  try {
    lookedAt = looked; garble([]);
    garbledReal = await ask("realgarbled", BROKEN, "192.0.2.9");
    lookedAt = looked; garble([1, 2]);
    garbledMade = await ask("garbled", BROKEN, "192.0.2.9");
  } finally { redis.pipeline = original; }
  is("a real store still opens the normal way; a made-up address does not, and neither is told to wait", [garbledReal?.store?.handle, garbledReal?.retryAfter, garbledMade?.store, garbledMade?.retryAfter, looked], ["realgarbled", 0, null, 0, 2]);
  try { lookedAt = looked; garble([7]); await ask("realgarbled2", BROKEN + 1, "192.0.2.9"); } finally { redis.pipeline = original; }
  is("an index of another kind is no answer either", looked, 3);

  part("The real lookup: a let-go name is a miss; a route answers a paced miss with 429, a real store with its page");
  redis.clear();
  await claimHandle("routes@example.com", "routeshop", "Route Shop", "");
  redis.run(["SET", "nl:store:handle:letgo", "released:old@example.com"]);
  const letGo = await watched(async () => { answer = (await lookUpVisitorStore("letgo", { now: DAY, address: "192.0.2.20" })) as never; });
  is("a let-go name reads its index alone and leads nowhere", [letGo.commands, answer], [1, { store: null, retryAfter: 0 }]);
  // Outside a request the asking connection is "none", the one every call above without an address used.
  let last: Response | null = null;
  for (let i = 0; i <= UNSEEN_STORE_LOOKUPS_PER_MINUTE; i++) {
    last = await manifest(new Request("https://marktmorgen.com/@x/manifest.webmanifest") as never, { params: Promise.resolve({ handle: `@${madeUp(N + i)}` }) });
  }
  is("past the pace, a made-up address's manifest is 429 with Retry-After", [last?.status, last?.headers.get("Retry-After"), last?.headers.get("Cache-Control")], [429, String(STORE_LOOKUP_RETRY_SECONDS), "no-store"]);
  const real = await manifest(new Request("https://marktmorgen.com/@routeshop/manifest.webmanifest") as never, { params: Promise.resolve({ handle: "@routeshop" }) });
  is("a real store's manifest is served to the same connection", real.status, 200);
  is("and storeForVisitor still finds it", (await storeForVisitor("routeshop"))?.handle, "routeshop");

  part("Every page and route of a store looks its address up through the visitor's lookup");
  const files = (readdirSync("app/[handle]", { recursive: true }) as string[]).map((f) => `app/[handle]/${f}`).filter((f) => /\.(ts|tsx)$/.test(f));
  const direct = files.filter((f) => readFileSync(f, "utf8").includes("storeForHandle(")).sort();
  is("none reads the address with storeForHandle", direct, []);
  is("the pace's figures stay what is written here and in docs/funded-exposure-review.md", [UNSEEN_STORE_LOOKUPS_PER_MINUTE, STORE_LOOKUP_RETRY_SECONDS], [30, 60]);

  part("What a made-up address costs, per request: no ceiling is claimed (docs/funded-exposure-review.md)");
  const micro = (n: number) => n / 1_000_000;
  const COMMAND = micro(UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1e6;
  const CALL = micro(VERCEL_CALL_MICRO_USD_PER_MILLION) / 1e6;
  const CPU_SECOND = micro(VERCEL_CPU_MICRO_USD_PER_HOUR) / 3600;
  const MEMORY_SECOND = VERCEL_FUNCTION_GB * micro(VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR) / 3600;
  const DB_BYTE = micro(UPSTASH_MICRO_USD_PER_GB_TRANSFER) / 1e9;
  // The not-found page as it travels, costed at 128 KB like the status page.
  const PAGE_BYTES = 128_000;
  // A request at its worst: the CDN's request, two calls, a second of CPU, memory held through each Redis wait at its
  // timeout plus a second, the commands, the bytes back and the page out.
  const request = (pipelines: number, commands: number, dbBytes: number) =>
    CDN_PER_REQUEST + 2 * CALL + CPU_SECOND + (pipelines * REDIS_TIMEOUT_MS / 1000 + 1) * MEMORY_SECOND
    + commands * COMMAND + dbBytes * DB_BYTE + PAGE_BYTES * ORIGIN_PER_BYTE;
  // A miss: one round trip, the index read; its value at its largest is a let-go mark of an email (320 bytes and more).
  const miss = request(1, 1, 384);
  // The index read inside it, its timeout's memory included: what the lookup itself adds to a request the host answers.
  const indexRead = COMMAND + 384 * DB_BYTE + (REDIS_TIMEOUT_MS / 1000) * MEMORY_SECOND;
  console.log(`  a made-up address's request at its worst $${miss.toFixed(6)}, of which the index read $${indexRead.toFixed(8)}`);
  is("the index read a made-up address costs is under a hundredth of a cent", indexRead < 0.0001, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
