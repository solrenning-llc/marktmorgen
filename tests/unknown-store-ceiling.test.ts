/**
 * Store addresses that lead nowhere, and ids that lead nowhere in a real store (traffic audit of 9 November 2026,
 * MÉDIO 2). Every page and route under app/[handle] first looks the address up in the database; without a store there
 * was no window to count it in, so a loop over made-up addresses from one machine was a database read each time and a
 * bill with no ceiling for the company. A made-up purchase-for-several id on a real store's page read the database
 * before anything counted the request.
 *
 * Held here: a connection's made-up addresses are paced in this server's memory before any read, a "nothing here" is
 * remembered for a short while, the company counts the day's misses and stops reading for unseen addresses past its
 * ceiling, and a real store's group page counts the request in the store's own window before it reads the group.
 */
import StorePage, { generateMetadata as storeMeta } from "@/app/[handle]/page";
import { GET as feed } from "@/app/[handle]/blog/feed.xml/route";
import GroupPage from "@/app/[handle]/group/[group]/page";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeForVisitor, type Store } from "@/lib/store";
import { readFileSync, readdirSync } from "node:fs";
import {
  STORE_FOUND_EXTRA_COMMANDS, STORE_LOOKUP_COMMANDS, STORE_LOOKUP_MEMORY_KEYS, STORE_KNOWN_MEMORY_MS, STORE_MISS_KEY_SECONDS, STORE_MISS_MEMORY_MS,
  STORE_MISSES_PER_DAY, type StoreProbe, UNSEEN_STORE_LOOKUPS_PER_MINUTE, forgetStoreLookups, lookUpStore, storeMissKey,
} from "@/lib/store-lookup";
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

  part("Made-up store addresses from one connection: paced before any read, counted by the company");
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
  is("the misses are counted for the company", all.counters > 0, true);
  is("one connection does not make the database read 2,000 times (at most 300 commands)", all.commands <= 300, true);

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

  part("The lookup itself: memory, the index, the pace and the company's day");
  forgetStoreLookups();
  redis.clear();
  const DAY = Date.UTC(2026, 10, 20, 12);
  let looked = 0, opened = 0;
  // A stand-in for lib/store.ts's probe: the index at test:idx:<handle>, the record at test:rec:<holder>.
  const probe = (handle: string): StoreProbe<{ handle: string }> => ({
    look: async (h) => { looked += 1; const [v] = await redis.pipeline([["GET", `test:idx:${h}`]]); return typeof v === "string" && v ? { handle: h } : null; },
    indexKey: `test:idx:${handle}`,
    holderOf: (value) => (typeof value === "string" && value ? value : null),
    open: async (holder, also) => { opened += 1; await redis.pipeline([["GET", `test:rec:${holder}`], ...also]); return { handle }; },
  });
  const day = async (now: number) => (await redis.pipeline([["GET", storeMissKey(now)]]))[0];
  const ask = (handle: string, now: number, address: string) => lookUpStore(handle, probe(handle), { now, address });
  const first = await watched(() => ask("nothere", DAY, "198.51.100.1"));
  is("a made-up address: the count and the index read, one round trip, nothing more", [first.commands, opened, looked], [STORE_LOOKUP_COMMANDS, 0, 0]);
  is("and the miss is counted for the company's day", await day(DAY), "1");
  const again = await watched(() => ask("nothere", DAY + STORE_MISS_MEMORY_MS - 1, "198.51.100.2"));
  is("asked again within the half minute, nothing is sent", [again.commands, await day(DAY)], [0, "1"]);
  is("after it, it is looked up again", [await ask("nothere", DAY + STORE_MISS_MEMORY_MS, "198.51.100.2"), await day(DAY)], [null, "2"]);

  redis.run(["SET", "test:idx:realshop", "owner@example.com"]);
  const realSeen = await watched(() => ask("realshop", DAY, "198.51.100.3"));
  is("a real store opens from its index, its record read with the count given back", [realSeen.commands, opened, await day(DAY)], [STORE_LOOKUP_COMMANDS + 1 + STORE_FOUND_EXTRA_COMMANDS, 1, "2"]);
  let served = 0;
  for (let i = 0; i < UNSEEN_STORE_LOOKUPS_PER_MINUTE * 3; i++) if (await ask("realshop", DAY + 1, "198.51.100.4")) served += 1;
  is("a store this server knows is never paced or counted here, and is read the normal way", [served, looked, await day(DAY)], [UNSEEN_STORE_LOOKUPS_PER_MINUTE * 3, UNSEEN_STORE_LOOKUPS_PER_MINUTE * 3, "2"]);

  part("One connection's minute: unseen addresses past the pace read nothing, for that connection only");
  forgetStoreLookups();
  const PACE_AT = DAY + 3_600_000;
  let paced = 0;
  for (let i = 0; i < UNSEEN_STORE_LOOKUPS_PER_MINUTE + 10; i++) paced += (await watched(() => ask(`pace${i}`, PACE_AT, "198.51.100.5"))).reads.length;
  is("only the minute's pace reads the index", paced, UNSEEN_STORE_LOOKUPS_PER_MINUTE);
  is("another connection is not refused for it", (await watched(() => ask("pacenew", PACE_AT, "198.51.100.6"))).reads.length, 1);

  part("The company's day: past its misses only the counting stops; the index still decides, and a real store opens");
  forgetStoreLookups();
  redis.clear();
  opened = 0;
  const FULL = DAY + 3 * 3_600_000;
  redis.run(["SET", storeMissKey(FULL), String(STORE_MISSES_PER_DAY - 1)]);
  redis.run(["SET", "test:idx:realcold", "cold@example.com"]);
  is("the last counted miss of the day", [await ask("lastone", FULL, "192.0.2.2"), await day(FULL)], [null, String(STORE_MISSES_PER_DAY)]);
  const pastMiss = await watched(() => ask("pastit", FULL + 1, "192.0.2.3"));
  is("past it, a made-up address sends the index read alone and counts nothing", [pastMiss.commands, pastMiss.counters, await day(FULL)], [1, 0, String(STORE_MISSES_PER_DAY)]);
  const pastReal = await watched(() => ask("realcold", FULL + 2, "192.0.2.4"));
  is("past it, a real store this server never saw opens", [pastReal.commands, opened, pastReal.counters], [2, 1, 0]);
  is("the next day it counts again", (await watched(() => ask("tomorrow", FULL + 86_400_000, "192.0.2.5"))).commands, STORE_LOOKUP_COMMANDS);

  part("A reply that cannot be read is no answer: the normal lookup decides, and nothing is paused");
  forgetStoreLookups();
  redis.clear();
  looked = 0;
  redis.run(["SET", "test:idx:realgarbled", "g@example.com"]);
  const BROKEN = DAY + 4 * 3_600_000;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (cmds) => (cmds.length === STORE_LOOKUP_COMMANDS ? [1, 1] : original(cmds));
  let garbledReal: { handle: string } | null = null, garbledMade: { handle: string } | null = null;
  try {
    garbledReal = await ask("realgarbled", BROKEN, "192.0.2.9");
    garbledMade = await ask("garbled", BROKEN, "192.0.2.9");
  } finally { redis.pipeline = original; }
  is("a real store still opens the normal way; a made-up address does not", [garbledReal?.handle, garbledMade, looked], ["realgarbled", null, 2]);
  redis.pipeline = async (cmds) => (cmds.length === STORE_LOOKUP_COMMANDS ? [1, 1, 7] : original(cmds));
  try { garbledReal = await ask("realgarbled2", BROKEN + 1, "192.0.2.9"); } finally { redis.pipeline = original; }
  is("an index of another kind is no answer either", looked, 3);
  is("and the next lookup reads at once", (await watched(() => ask("garbled3", BROKEN + 2, "192.0.2.10"))).commands, STORE_LOOKUP_COMMANDS);

  part("Every page and route of a store looks its address up through the visitor's lookup");
  const files = (readdirSync("app/[handle]", { recursive: true }) as string[]).map((f) => `app/[handle]/${f}`).filter((f) => /\.(ts|tsx)$/.test(f));
  // Two files other open work rewrites, listed here so they cannot be forgotten: app/[handle]/p/[product]/opengraph-image.tsx
  // (reserved by claude5/public-admission-book with the rest of that page) and the certificate's card (#3374 and #3409,
  // which count the store's request before the record): each moves to storeForVisitor after them.
  const waiting = ["app/[handle]/certificate/[id]/opengraph-image.tsx", "app/[handle]/p/[product]/opengraph-image.tsx"];
  const direct = files.filter((f) => readFileSync(f, "utf8").includes("storeForHandle(")).sort();
  is("none reads the address with storeForHandle", direct, waiting);
  is("the lookup's figures stay what the cost below prices", [STORE_LOOKUP_COMMANDS, STORE_FOUND_EXTRA_COMMANDS, STORE_MISS_MEMORY_MS, STORE_KNOWN_MEMORY_MS, STORE_MISS_KEY_SECONDS, STORE_LOOKUP_MEMORY_KEYS], [3, 1, 30_000, 3_600_000, 172_800, 20_000]);

  part("What the misses cost the company, a fixed cost (MR item 2, docs/funded-exposure-review.md)");
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
  // A counted miss: one round trip, the count and the index read; the index names nobody, so no record is read.
  // Its value at its largest is an address's holder (an email, 320 bytes) or a let-go mark; the count a number.
  const counted = request(1, STORE_LOOKUP_COMMANDS, 320 + 64);
  const MONTH_DAYS = 31;
  const month = STORE_MISSES_PER_DAY * MONTH_DAYS * counted;
  // Past the ceiling a miss is the index read alone: what the code adds to a request the host answers anyway.
  const pastReadOnly = COMMAND + 384 * DB_BYTE + (REDIS_TIMEOUT_MS / 1000) * MEMORY_SECOND;
  // One machine past the ceiling, at its pace on one server, a whole month.
  const oneMachineServer = UNSEEN_STORE_LOOKUPS_PER_MINUTE * 60 * 24 * MONTH_DAYS * pastReadOnly;
  console.log(`  a counted miss at its worst $${counted.toFixed(6)}; the counted misses' month $${month.toFixed(2)}; past the ceiling the read the code adds $${pastReadOnly.toFixed(8)} a miss; one connection on one server at its pace $${oneMachineServer.toFixed(2)} a month`);
  is("the counted misses stay under $60 a month", month < 60, true);
  is("past the ceiling a miss adds under a hundredth of a cent of reading", pastReadOnly < 0.0001, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
