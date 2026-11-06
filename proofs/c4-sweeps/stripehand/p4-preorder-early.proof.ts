/**
 * P4. lib/preorders.ts soonOne (~:71-75), read by confirmPreorder (~:341-353). `member === 1 || member === "1"`: a
 * SISMEMBER answered in another shape reads as "not coming soon", so a pre-order paid for a product still coming
 * soon is handed over at once (grant + "it is out" email) instead of being kept for its release.
 * Real MemoryRedis; one reply replaced after it ran.
 */
import { confirmPreorder } from "@/lib/preorders";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "@/tests/redis-stub";
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";

const SID = "pre0stats0002";
const store = { statsId: SID, sid: "presid0002", handle: "harbor", stripeAccountId: "acct_1Proof00000002", pastBuyers: true, name: "Harbor", language: "en", email: "owner@example.com", previousHandles: [], releasedHandles: [] } as unknown as Store;
const product = { id: "prod00000003", title: "Unreleased Album", course: null } as unknown as Listing;
const deps = { base: "https://example.com/@harbor", from: "Harbor <x@example.com>", ordersLink: async () => null, recordStart: async () => {} };
const session = (id: string, email: string) => ({ id, status: "complete", payment_status: "paid", created: 1_700_000_000, customer_details: { email }, metadata: { preorder: "yes", store: "harbor", product: product.id } });

async function run(label: string, id: string, email: string, alter?: (r: unknown) => unknown) {
  const real = redis.pipeline.bind(redis);
  if (alter) redis.pipeline = (async (c: (string | number)[][]) => {
    const a = await real(c);
    return c[0]?.[0] === "SISMEMBER" ? [alter(a[0]), ...a.slice(1)] : a;
  }) as typeof redis.pipeline;
  const outcome = await confirmPreorder(store, session(id, email) as Parameters<typeof confirmPreorder>[1], product, deps).catch((e: Error) => `threw ${e.message}`);
  redis.pipeline = real;
  const given = (await importedFor(store, email)).length;
  console.log(`${label}: outcome=${outcome} handedOverNow=${given > 0}`);
}

async function main() {
  redis.clear();
  redis.run(["SADD", `nl:wl:${SID}:soon`, product.id]);
  await run("control, coming soon read exactly", "cs_test_preearly0000000001", "ann@example.com");
  await run("SISMEMBER answered with no result", "cs_test_preearly0000000002", "bob@example.com", () => undefined);
  await run("SISMEMBER answered true", "cs_test_preearly0000000003", "cat@example.com", () => true);
}
main().catch((e) => { console.error(e); process.exit(1); });
