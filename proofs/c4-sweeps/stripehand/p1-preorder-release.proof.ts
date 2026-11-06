/**
 * P1. lib/preorders.ts runPreorderReleases (~:389-433). A released product's job reads its pre-orders with HGETALL
 * and reads the product and the store through injected readers that answer null on an unknown read. A reply in
 * another shape gives no pairs (and no waiting), left = 0, and the job is SREM'd from nl:pre:jobs. Nothing re-adds it:
 * the paid pre-order is never handed over, even once the read heals. Same for an unknown product or store read.
 * Real MemoryRedis; only one reply replaced, after it ran.
 */
import { runPreorderReleases } from "@/lib/preorders";
import { store as redis } from "@/tests/redis-stub";
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";

const SID = "pre0stats0001";
const PID = "prod00000001";
const SESSION = "cs_test_preorderproof000001";
const member = `${SID}|${PID}|harbor`;
const store = { statsId: SID, sid: "", handle: "harbor", stripeAccountId: "acct_1Proof00000001", pastBuyers: true, name: "Harbor", language: "en", email: "owner@example.com" } as unknown as Store;
const product = { id: PID, title: "Synthetic Guide", course: null } as unknown as Listing;
const handed: string[] = [];
const deps = { base: "https://example.com/@harbor", from: "Harbor <x@example.com>", ordersLink: async () => null, recordStart: async () => {} };

function seed() {
  redis.clear();
  redis.run(["SADD", "nl:pre:jobs", member]);
  redis.run(["HSET", `nl:pre:${SID}:${PID}`, SESSION, JSON.stringify({ to: "buyer@example.com", at: 1_700_000_000, pi: "" })]);
}
const jobs = () => redis.run(["SMEMBERS", "nl:pre:jobs"]) as string[];
const entry = () => JSON.parse(String(redis.run(["HGET", `nl:pre:${SID}:${PID}`, SESSION])));

async function once(label: string, opts: { hgetall?: (r: unknown) => unknown; product?: Listing | null; store?: Store | null }) {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (c: (string | number)[][]) => {
    const a = await real(c);
    return c[0]?.[0] === "HGETALL" && String(c[0]?.[1]).startsWith("nl:pre:") && opts.hgetall ? [opts.hgetall(a[0])] : a;
  }) as typeof redis.pipeline;
  let given = -1;
  try {
    given = await runPreorderReleases(async () => (opts.store === undefined ? store : opts.store), async () => (opts.product === undefined ? product : opts.product), () => deps, Date.now() + 10_000);
  } catch (e) {
    console.log(`  ${label}: threw ${(e as Error).message}`);
  } finally {
    redis.pipeline = real;
  }
  console.log(`  ${label}: given=${given} jobLeft=${jobs().includes(member)} entryGiven=${Boolean(entry().given)}`);
}

async function main() {
  console.log("control (healthy read): handed over");
  seed();
  await once("healthy", {});
  for (const [label, opts] of [
    ["HGETALL answered with no result (undefined)", { hgetall: () => undefined }],
    ["HGETALL answered an object", { hgetall: () => ({}) }],
    ["the product read unknown (readListing lenient: null)", { product: null }],
    ["the store read unknown (storeForHandle lenient: null)", { store: null }],
  ] as [string, Parameters<typeof once>[1]][]) {
    console.log(label);
    seed();
    await once("unknown read", opts);
    await once("read healed, next run", {});
  }
  void handed;
}
main().catch((e) => { console.error(e); process.exit(1); });
