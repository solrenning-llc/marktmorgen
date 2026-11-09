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
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
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
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
