/**
 * Three caches written after a provider read are kept only while the store is live (#5010 rows 112, 120 and 129):
 * - row 120 (Codex L-20261119-1735): the account's payment currencies, nl:pay:currencies:<account>;
 * - row 129 (Codex L-20261119-1830): today's sales, nl:stats:<statsId>:today:<day>;
 * - row 112 (Codex L-20261119-1738): what the emails sold and the visits they brought, nl:stats:<statsId>:mailsales:v2
 *   and nl:stats:<statsId>:mailvisits.
 * Each was a plain SET EX after the read, so a store whose erasure began meanwhile got the cache written back after
 * the erasure's walk and the late reading shown. Each now goes through setWhileStoreLive (lib/store-live-cache.ts):
 * nothing is kept for an erasing store and the reading is "not known" (null), and a live store is kept as before.
 * Real code over the memory Redis stub, with stand-ins for Stripe; synthetic data only.
 */
import { chargeableCurrencies } from "@/lib/payment-methods";
import { readMailRevenuePaid, readMailVisits } from "@/lib/mail-revenue";
import { readToday } from "@/lib/stats";
import { ERASING_KEY, claimHandle, ensureStatsId, erasingField, setPayPalSeller, setStripeAccount, storeForEmail, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_provider_caches_after_erasure";
const ACCOUNT = "acct_1TestCacheErase01";
const OWNER = "provider-caches@example.test";

// The erasure begins while Stripe is being read, when `eraseDuring` is set.
let eraseDuring: Store | null = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (eraseDuring) redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(eraseDuring)), String(Date.now())]);
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if (path === "/account") return new Response(JSON.stringify({ id: ACCOUNT, country: "US" }));
  if (path === "/country_specs/US") return new Response(JSON.stringify({ id: "US", supported_payment_currencies: ["usd", "cad"] }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

async function liveStore(): Promise<Store> {
  redis.clear();
  eraseDuring = null;
  if (!(await claimHandle(OWNER, "cacheerase", "Fictional caches", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setPayPalSeller(OWNER, "7KNGBPH2U58GQ");
  const store = (await storeForEmail(OWNER))!;
  if (!store.statsId) throw new Error("no statsId");
  return store;
}
const exists = (key: string) => Number(redis.run(["EXISTS", key]));
async function markErasing(store: Store): Promise<string> {
  const field = await erasingField(storeRef(store));
  redis.run(["HSET", ERASING_KEY, field, String(Date.now())]);
  return field;
}

async function main(): Promise<void> {
  part("Row 120: the account's currencies, while Stripe is read");
  {
    const store = await liveStore();
    const key = `nl:pay:currencies:${ACCOUNT}`;
    eraseDuring = store;
    const late = await chargeableCurrencies(store);
    eraseDuring = null;
    is("an erasing store's late list is not known (null), never shown", late, null);
    is("and nothing is written back under the account", exists(key), 0);
    redis.run(["HDEL", ERASING_KEY, await erasingField(storeRef(store))]);
    is("control: a live store's list is read and kept", [await chargeableCurrencies(store), exists(key)], [["usd", "cad"], 1]);
  }

  part("Row 129: today's sales, once the store is being erased");
  {
    const store = await liveStore();
    const field = await markErasing(store);
    const today = await readToday(store);
    is("an erasing store's sales today are not read just now (null)", today.sales, null);
    is("and no money cache is written back", exists(`nl:stats:${store.statsId}:today:${today.date}`), 0);
    redis.run(["HDEL", ERASING_KEY, field]);
    const live = await readToday(store);
    is("control: a live store's sales today are read and kept", [live.sales, exists(`nl:stats:${store.statsId}:today:${live.date}`)], [{ sales: 0, cents: 0 }, 1]);
  }

  part("Row 112: what the emails sold, while Stripe is read");
  {
    const store = await liveStore();
    const key = `nl:stats:${store.statsId}:mailsales:v2`;
    eraseDuring = store;
    const late = await readMailRevenuePaid(store, null);
    eraseDuring = null;
    is("an erasing store's late reading is not known (null), never shown", late, null);
    is("and no revenue cache is written back", exists(key), 0);
    redis.run(["HDEL", ERASING_KEY, await erasingField(storeRef(store))]);
    const live = await readMailRevenuePaid(store, null);
    is("control: a live store's reading is kept", [live !== null && live !== "refused", exists(key)], [true, 1]);
  }

  part("Row 112: the visits the emails brought, once the store is being erased");
  {
    const store = await liveStore();
    const key = `nl:stats:${store.statsId}:mailvisits`;
    const field = await markErasing(store);
    is("an erasing store's visits are not known (null)", await readMailVisits(store, ["0123456789abcdef01234567"]), null);
    is("and no visits cache is written back", exists(key), 0);
    redis.run(["HDEL", ERASING_KEY, field]);
    is("control: a live store's visits are read and kept", [await readMailVisits(store, ["0123456789abcdef01234567"]), exists(key)], [{ "0123456789abcdef01234567": 0 }, 1]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
