/**
 * The failed-renewals report is kept for ten minutes for a store from before ids too (board #5285, row #4887: Claude
 * 4's LOW, cost). recoveryReport needs a statsId but wrote its cache through its own script, which checked only the
 * store's id key (EXISTS); a store kept from before ids has no id key (sid ""), so its report was never kept and every
 * studio view read up to ten pages of Stripe again. It now writes through the shared fence (lib/live-fence.ts,
 * setWhileStoreLive): a store with an id while its id key holds its own ref, one from before ids while its owner's
 * record is still its own (its statsId), never while it is being erased.
 *
 * Synthetic only: the Redis stand-in and a Stripe stand-in that counts its reads.
 */
import { recoveryReport } from "@/lib/payment-recovery-report";
import { ERASING_KEY, type Store, erasingField, ownerKey, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const now = Date.UTC(2026, 10, 5, 1);
const legacy = { sid: "", email: "owner-recovery-legacy@example.com", handle: "recovery-legacy", previousHandles: [], releasedHandles: [], stripeAccountId: "acct_test_recovery_legacy", statsId: "e".repeat(32), currency: "usd" } as unknown as Store;
const cache = `nl:dun:report:${legacy.statsId}:v2`;
let reads = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname !== "/v1/invoices") throw new Error("Unexpected provider operation");
  reads += 1;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_recovery_legacy";
  const record = async (statsId: string) => redis.pipeline([["SET", await ownerKey(storeRef(legacy)), JSON.stringify({ statsId, handle: legacy.handle })]]);

  part("A store from before ids, its owner's record still its own");
  redis.clear();
  await record(legacy.statsId!);
  await recoveryReport(legacy, false, now);
  is("control: Stripe was read once", reads, 1);
  is("the report is kept", (await redis.pipeline([["GET", cache]]))[0] !== null, true);
  await recoveryReport(legacy, false, now);
  is("so the next view reads the kept report, not Stripe", reads, 1);

  part("Never kept for a store that is not this one, or one being erased");
  redis.clear();
  reads = 0;
  await record("d".repeat(32));
  await recoveryReport(legacy, false, now);
  is("the owner's record now belongs to another store: not kept", (await redis.pipeline([["GET", cache]]))[0], null);
  redis.clear();
  await record(legacy.statsId!);
  await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(legacy)), String(now)]]);
  await recoveryReport(legacy, false, now);
  is("being erased: not kept", (await redis.pipeline([["GET", cache]]))[0], null);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
