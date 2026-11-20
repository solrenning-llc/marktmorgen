/**
 * A store leaves the share settlement's indexes only when it is confirmed gone (lib/share-settle.ts, settleShares;
 * lib/store-exact.ts, storeForRefExactly; CX-123 rule 24).
 *
 * Before: storeForEmail answers null both for a store that is not there and for a reply cut short or of another
 * shape, and settleShares read either as gone: the store left nl:share:stores and its applied percentage and read
 * cursor were deleted, so the share of what it refunded was never given back. Now an unknown read keeps all three and
 * marks the run incomplete; a store whose owner key is confirmed absent still leaves.
 *
 * Synthetic only: the in-memory Redis and no Stripe call that matters (the run is not live).
 */
import { createHash } from "node:crypto";
import { settleShares } from "@/lib/share-settle";
import { storeForRefExactly } from "@/lib/store-exact";
import { claimHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

type Batch = (string | number)[][];
const original = redis.pipeline.bind(redis);
const ownerKey = (email: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${email.toLowerCase()}`).digest("hex").slice(0, 40)}`;
let badOwnerReads: unknown[] | null = null;
redis.pipeline = (async (b: Batch) => {
  if (badOwnerReads && b.length === 1 && b[0][0] === "GET" && String(b[0][1]).startsWith("nl:store:owner:")) return badOwnerReads;
  return original(b);
}) as typeof redis.pipeline;

const REF = "sharing@example.com";
const kept = async () => {
  const [member, applied, until] = await original([["SISMEMBER", "nl:share:stores", REF], ["HGET", "nl:share:applied", REF], ["HGET", "nl:share:read-until", REF]]);
  return [member, applied, until];
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_share_only_a_stand_in";
  await claimHandle(REF, "sharing-shop", "Sharing Shop", "");
  const seed = async () => original([["SADD", "nl:share:stores", REF], ["HSET", "nl:share:applied", REF, "275"], ["HSET", "nl:share:read-until", REF, "1900000000"]]);

  for (const [label, reply] of [["no reply", []], ["a number", [7]], ["two replies", [null, null]]] as [string, unknown[]][]) {
    part(`The store's record read as ${label}`);
    await seed();
    badOwnerReads = reply;
    is("storeForRefExactly: unknown", await storeForRefExactly(REF), "unknown");
    const counts = await settleShares(Date.now() + 30_000, 1_900_000_100, false);
    badOwnerReads = null;
    is("the store stays in the indexes, with its percentage and its cursor", await kept(), [1, "275", "1900000000"]);
    is("the run is not complete", counts.complete, false);
  }

  part("A store whose record is confirmed gone");
  await seed();
  await original([["DEL", ownerKey(REF)]]);
  is("storeForRefExactly: none", await storeForRefExactly(REF), "none");
  await settleShares(Date.now() + 30_000, 1_900_000_100, false);
  is("it leaves the indexes", await kept(), [0, null, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
