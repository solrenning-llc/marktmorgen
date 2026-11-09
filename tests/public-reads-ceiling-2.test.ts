/**
 * Two more public reads paid for before they read (4 November 2026,
 * lib/page-read-rules.ts; the inventory of reads with no ceiling, items 12
 * and 17), against the in-memory Redis double and synthetic stores only:
 *
 *   - a license check takes its request before it reads the product or the
 *     key, and refused reads neither;
 *   - a collection page takes a request for each few of its products before
 *     it reads them.
 */
import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { GET as licence } from "@/app/api/store/licence/route";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { requestLimitFor } from "@/lib/traffic-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

/** Every command sent while `run` runs. */
async function watched<T>(run: () => Promise<T>): Promise<{ value: T; names: string[] }> {
  const original = redis.pipeline;
  const names: string[] = [];
  try {
    redis.pipeline = async (commands) => {
      for (const c of commands) names.push(String(c[0]));
      return original.call(redis, commands);
    };
    return { value: await run(), names };
  } finally {
    redis.pipeline = original;
  }
}

function asked(url: string): NextRequest {
  const at = new URL(url);
  return Object.assign(new Request(at, { headers: { "x-forwarded-for": "198.51.100.7" } }), { nextUrl: at }) as unknown as NextRequest;
}

const between = (source: string, first: string, then: string) => {
  const a = source.indexOf(first);
  const b = source.indexOf(then);
  return a > 0 && b > a;
};

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("A license check pays before it reads");
  const OWNER = "keys@example.com";
  await claimHandle(OWNER, "keyshop", "Key Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_keys", subscriptionId: "sub_keys", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Plugin", "", "19", null);
  if (!made.ok) throw new Error("no product");
  const shop = (await storeForEmail(OWNER))!;
  const url = `https://marktmorgen.com/api/store/licence?store=keyshop&product=${made.product.id}&key=ABCD-EFGH-IJKL-MNOP`;
  const first = await licence(asked(url));
  is("with room: answered", first.status, 200);
  await takePublicRequest(shop, "buyer", Date.now(), requestLimitFor(shop));
  const refused = await watched(() => licence(asked(url)));
  is("refused once the window is used: 429", refused.value.status, 429);
  const route = readFileSync("app/api/store/licence/route.ts", "utf8");
  is("its request is taken before the product is read and before the key is checked", [between(route, 'takePublicRequest(store, "buyer")', "readListing(store, productId)"), between(route, 'takePublicRequest(store, "buyer")', "checkKey(store, product, key)")], [true, true]);

  part("A collection pays for its products before it reads them");
  const collection = readFileSync("app/[handle]/shop/[collection]/page.tsx", "utf8");
  is("its products' requests come before their listings, and refused it rests", [between(collection, "collectionUnits(ids.length)", "await readListings(store, ids)"), collection.includes('collectionUnits(ids.length)))) return <StoreResting store={store} />;')], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
