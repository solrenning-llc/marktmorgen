/**
 * A membership's status is kept only while the store is live (Codex L-20261119-1248, #5010 row 115): it was written
 * with a plain SET after the Stripe read, so a request racing the store's erasure got live access evidence and the
 * cache back. It now goes through setWhileStoreLive (lib/store-live-cache.ts): an erasing store keeps nothing and the
 * membership is no membership (null, never live); a write whose answer is unknown is unknown (UnknownReplyError); a
 * live store is kept as before. Synthetic stores; in-memory Redis; Stripe stood in.
 */
import { ERASING_KEY, claimHandle, ensureStatsId, erasingField, setStripeAccount, setSubscription, storeForEmail, storeRef, type Store } from "@/lib/store";
import { isLive, membershipStatus } from "@/lib/membership-access";
import { UnknownReplyError } from "@/lib/redis-reply";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_about_membership_erasure_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const ACCOUNT = "acct_1TestAboutErase";
const SUB = "sub_AboutErase000001";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === `/v1/subscriptions/${SUB}`) return new Response(JSON.stringify({ id: SUB, status: "active", pause_collection: null }));
  throw new Error(`no stand-in for ${url.pathname}`);
}) as typeof fetch;

const exists = (key: string) => Number(redis.run(["EXISTS", key]));
async function erasing(store: Store, on: boolean): Promise<void> {
  const field = await erasingField(storeRef(store));
  redis.run(on ? ["HSET", ERASING_KEY, field, String(Date.now())] : ["HDEL", ERASING_KEY, field]);
}
async function liveStore(owner: string, handle: string): Promise<Store> {
  redis.clear();
  await claimHandle(owner, handle, "Fictional Club", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, ACCOUNT, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() } as never);
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  part("Row 115: a membership's status while the store is being erased");
  {
    const store = await liveStore("member-erase@example.test", "membererase");
    const key = `nl:member:status:${ACCOUNT}:${SUB}`;
    await erasing(store, true);
    const late = await membershipStatus(store, SUB);
    is("an erasing store's membership is no membership (null), never live", [late, isLive(late)], [null, false]);
    is("and no status cache is written back", exists(key), 0);
    await erasing(store, false);
    is("control: a live store's membership is active and kept", [await membershipStatus(store, SUB), exists(key)], ["active", 1]);
  }

  part("Row 115: a fenced write whose answer is unknown is unknown, never live");
  {
    const store = await liveStore("member-unknown@example.test", "memberunknown");
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands[0]?.[0] === "EVAL" && String(commands[0]?.[1]).includes("store-cache-live") ? ["OK"] : real(commands)) as typeof redis.pipeline;
    let error: unknown = null;
    try {
      await membershipStatus(store, SUB);
    } catch (caught) {
      error = caught;
    } finally {
      redis.pipeline = real;
    }
    is("an answer other than kept or gone throws UnknownReplyError", error instanceof UnknownReplyError, true);
  }

  part("A store from before ids with no statsId: the fence cannot tell it, so nothing is kept, and its erasure is still read (review of #5272)");
  {
    redis.clear();
    await claimHandle("member-legacy@example.test", "memberlegacy", "Fictional Old Club", "");
    await setStripeAccount("member-legacy@example.test", ACCOUNT, true);
    // A store kept from before ids: no id and no statsId (as tests/ad-events-erasure.test.ts reads one).
    const store: Store = { ...(await storeForEmail("member-legacy@example.test"))!, sid: "", statsId: "" };
    is("(control) the store has neither an id nor a statsId", [/^[0-9a-f]{32}$/.test(store.sid ?? ""), store.statsId || null], [false, null]);
    const key = `nl:member:status:${ACCOUNT}:${SUB}`;
    is("a live old store's membership is active, as on main, never an error", await membershipStatus(store, SUB).catch((error) => (error instanceof UnknownReplyError ? "unknown" : "threw")), "active");
    is("and nothing is kept for it (no fence can hold the write)", exists(key), 0);
    await erasing(store, true);
    const late = await membershipStatus(store, SUB);
    is("an old store being erased: no membership (null), never live", [late, isLive(late)], [null, false]);
    is("and still nothing is kept", exists(key), 0);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
