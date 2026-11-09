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
import { MAX_STORE_BYTES, claimHandle, ensureStatsId, setSubscription, storeForEmail, storeForHandle, type Store } from "@/lib/store";
import { readFileSync, readdirSync } from "node:fs";
import {
  STORE_LOOKUP_MEMORY_KEYS, STORE_KNOWN_MEMORY_MS, STORE_MISS_COUNT_COMMANDS, STORE_MISS_KEY_SECONDS, STORE_MISS_MEMORY_MS,
  STORE_MISSES_PER_CONNECTION_PER_DAY, STORE_MISSES_PER_DAY, UNSEEN_STORE_LOOKUPS_PER_MINUTE, forgetStoreLookups, lookUpStore, storeMissKey,
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
  is("(setup) the store is found for a visitor", (await lookUpStore("groupscan", storeForHandle, { address: "203.0.113.50" }))?.handle, "groupscan");
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

  part("The lookup itself: memory, pace, the connection's share and the company's day");
  forgetStoreLookups();
  const DAY = Date.UTC(2026, 10, 20, 12);
  let looked = 0;
  const look = async (handle: string) => { looked += 1; return handle.startsWith("real") ? { handle } : null; };
  const hash = async (now: number) => (await redis.pipeline([["HGET", storeMissKey(now), "all"]]))[0];
  is("a made-up address is looked up once", await lookUpStore("nothere", look, { now: DAY, address: "198.51.100.1" }), null);
  is("and counted for the company's day", await hash(DAY), "1");
  is("asked again within the half minute, nothing is read or counted", [await lookUpStore("nothere", look, { now: DAY + STORE_MISS_MEMORY_MS - 1, address: "198.51.100.2" }), looked, await hash(DAY)], [null, 1, "1"]);
  is("after it, it is looked up again", [await lookUpStore("nothere", look, { now: DAY + STORE_MISS_MEMORY_MS, address: "198.51.100.2" }), looked, await hash(DAY)], [null, 2, "2"]);

  const realSeen = await watched(() => lookUpStore("realshop", look, { now: DAY, address: "198.51.100.3" }));
  is("a real store is found and sends nothing of the lookup's own", [realSeen.commands, looked], [0, 3]);
  // Its next visitors are not paced: one connection asks for it far past the minute's pace.
  let served = 0;
  for (let i = 0; i < UNSEEN_STORE_LOOKUPS_PER_MINUTE * 3; i++) if (await lookUpStore("realshop", look, { now: DAY + 1, address: "198.51.100.4" })) served += 1;
  is("a store this server knows is never paced here", served, UNSEEN_STORE_LOOKUPS_PER_MINUTE * 3);

  part("One connection's minute: unseen addresses past the pace read nothing");
  forgetStoreLookups();
  looked = 0;
  for (let i = 0; i < UNSEEN_STORE_LOOKUPS_PER_MINUTE + 10; i++) await lookUpStore(`pace${i}`, look, { now: DAY + 3_600_000, address: "198.51.100.5" });
  is("only the minute's pace is looked up", looked, UNSEEN_STORE_LOOKUPS_PER_MINUTE);
  await lookUpStore("pacenew", look, { now: DAY + 3_600_000, address: "198.51.100.6" });
  is("another connection is not refused for it", looked, UNSEEN_STORE_LOOKUPS_PER_MINUTE + 1);

  part("One connection's share of the day: past it, that connection reads nothing more today");
  forgetStoreLookups();
  redis.clear();
  looked = 0;
  const SHARE_AT = DAY + 2 * 3_600_000;
  for (let i = 0; i < STORE_MISSES_PER_CONNECTION_PER_DAY + 5; i++) {
    // A minute apart every pace, so only the share can refuse.
    await lookUpStore(`share${i}`, look, { now: SHARE_AT + Math.floor(i / UNSEEN_STORE_LOOKUPS_PER_MINUTE) * 60_000, address: "203.0.113.7" });
  }
  is("the connection's share is looked up, then nothing", looked, STORE_MISSES_PER_CONNECTION_PER_DAY);
  await lookUpStore("othershare", look, { now: SHARE_AT + 3_600_000, address: "203.0.113.8" });
  is("another connection still is", looked, STORE_MISSES_PER_CONNECTION_PER_DAY + 1);
  await lookUpStore("nextday", look, { now: DAY + 86_400_000, address: "203.0.113.7" });
  is("and the connection again the next day", looked, STORE_MISSES_PER_CONNECTION_PER_DAY + 2);

  part("The company's day: past its misses, an unseen address reads nothing until the day turns");
  forgetStoreLookups();
  redis.clear();
  looked = 0;
  const FULL = DAY + 3 * 3_600_000;
  redis.run(["HSET", storeMissKey(FULL), "all", String(STORE_MISSES_PER_DAY - 1)]);
  await lookUpStore("realknown", look, { now: FULL, address: "192.0.2.1" });
  is("the last miss of the day is read", [await lookUpStore("lastone", look, { now: FULL, address: "192.0.2.2" }), looked, await hash(FULL)], [null, 2, String(STORE_MISSES_PER_DAY)]);
  const after = await watched(() => lookUpStore("pastit", look, { now: FULL + 1, address: "192.0.2.3" }));
  is("past it, an unseen address reads and counts nothing", [after.commands, looked], [0, 2]);
  is("a store this server knows is still found", (await lookUpStore("realknown", look, { now: FULL + 2, address: "192.0.2.4" }))?.handle, "realknown");
  is("the next day it reads again", [await lookUpStore("tomorrow", look, { now: FULL + 86_400_000, address: "192.0.2.5" }), looked], [null, 4]);

  part("A count that cannot be read is no room: this server reads nothing for unseen addresses for a minute");
  forgetStoreLookups();
  looked = 0;
  const BROKEN = DAY + 4 * 3_600_000;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (cmds) => (String(cmds[0]?.[0]) === "HINCRBY" ? [1, "1", 1] : original(cmds));
  try { await lookUpStore("garbled", look, { now: BROKEN, address: "192.0.2.9" }); } finally { redis.pipeline = original; }
  await lookUpStore("garbled2", look, { now: BROKEN + 59_999, address: "192.0.2.10" });
  is("within the minute nothing more is read", looked, 1);
  await lookUpStore("garbled3", look, { now: BROKEN + 60_000, address: "192.0.2.10" });
  is("after it, it reads again", looked, 2);

  part("Every page and route of a store looks its address up through the visitor's lookup");
  const files = (readdirSync("app/[handle]", { recursive: true }) as string[]).map((f) => `app/[handle]/${f}`).filter((f) => /\.(ts|tsx)$/.test(f));
  // Two files other open work rewrites, listed here so they cannot be forgotten: app/[handle]/p/[product]/opengraph-image.tsx
  // (reserved by claude5/public-admission-book with the rest of that page) and the certificate's card (#3374 and #3409,
  // which count the store's request before the record): each moves to storeForVisitor after them.
  const waiting = ["app/[handle]/certificate/[id]/opengraph-image.tsx", "app/[handle]/p/[product]/opengraph-image.tsx"];
  const direct = files.filter((f) => readFileSync(f, "utf8").includes("storeForHandle(")).sort();
  is("none reads the address with storeForHandle", direct, waiting);
  is("the lookup's figures stay what the cost below prices", [STORE_MISS_COUNT_COMMANDS, STORE_MISS_MEMORY_MS, STORE_KNOWN_MEMORY_MS, STORE_MISS_KEY_SECONDS, STORE_LOOKUP_MEMORY_KEYS], [3, 30_000, 3_600_000, 172_800, 20_000]);

  part("What the misses cost the company at the ceiling, a fixed cost (MR item 2, docs/funded-exposure-review.md)");
  const micro = (n: number) => n / 1_000_000;
  const COMMAND = micro(UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1e6;
  const CALL = micro(VERCEL_CALL_MICRO_USD_PER_MILLION) / 1e6;
  const CPU_SECOND = micro(VERCEL_CPU_MICRO_USD_PER_HOUR) / 3600;
  const MEMORY_SECOND = VERCEL_FUNCTION_GB * micro(VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR) / 3600;
  const DB_BYTE = micro(UPSTASH_MICRO_USD_PER_GB_TRANSFER) / 1e9;
  // The not-found page as it travels, costed at 128 KB like the status page.
  const PAGE_BYTES = 128_000;
  // A miss at its worst: the address's GET and the record's GET (a record that cannot be read is a miss too, at its
  // largest, MAX_STORE_BYTES), then the count; three pipelines, each waited at its timeout; the CDN's request, two
  // calls, a second of CPU and the page out.
  const pipelines = 3;
  const commands = 2 + STORE_MISS_COUNT_COMMANDS;
  const dbBytes = 320 + MAX_STORE_BYTES + 64;
  const miss = CDN_PER_REQUEST + 2 * CALL + CPU_SECOND + (pipelines * REDIS_TIMEOUT_MS / 1000 + 1) * MEMORY_SECOND
    + commands * COMMAND + dbBytes * DB_BYTE + PAGE_BYTES * ORIGIN_PER_BYTE;
  const MONTH_DAYS = 31;
  const month = STORE_MISSES_PER_DAY * MONTH_DAYS * miss;
  // Beyond the ceiling each server reads at most the misses it had in flight when it learned the day was used: one
  // each, priced per server.
  const perServer = MONTH_DAYS * miss;
  console.log(`  a miss at its worst $${miss.toFixed(6)}; the ceiling's month $${month.toFixed(2)}; one server's misses past it $${perServer.toFixed(4)} a month`);
  is("the misses read at the ceiling stay under $60 a month", month < 60, true);
  is("one server's misses past the ceiling stay under a cent a month", perServer < 0.01, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
