/**
 * A closing store's PayPal buyers are told before its closing goes on (lib/closing-buyers.ts, tellBuyers; 5bNDa on
 * #4001, MEDIUM). The first round reads the store's PayPal sales (lib/paypal-sales.ts, readPayPalSales) and took only
 * `sales`, never `partial`: a sale whose record was missing, or written for another store, was left out in silence,
 * the round was marked done (`after` "start") and that buyer was never told the store was closing.
 *
 * Now a partial reading tells everyone it did read (each written down at once, so no one is told twice) and leaves
 * the round where it was: the closing job holds and reads them again on its next run, as for an answer it could not
 * read, and the store does not close before its buyers are told (lib/plan-closing.ts).
 *
 * Synthetic only: the in-memory Redis.
 */
import { startClosingCredit } from "@/lib/closing-credit";
import { tellBuyers, toldKey } from "@/lib/closing-buyers";
import { claimHandle, ensureStatsId, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "closing-paypal-partial@example.com";
const KEPT = "ORDERPAYPALKEPT0001";
const LOST = "ORDERPAYPALLOST0002";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.COMPANY_POSTAL_ADDRESS = "1 Test Street, Testville, DE 19901, USA";
  await claimHandle(OWNER, "closingpaypal", "Closing PayPal", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const folder = await storeFolder(storeRef(store));
  const E = Date.UTC(2026, 10, 1);
  const day = E + 30 * 86_400_000;
  const now = Math.floor(Date.now() / 1000);
  const paid = (order: string, email: string) => JSON.stringify({ store: statsId, order, capture: `CAP${order}`, email, product: "guide", title: "Guide", cents: 2_000, currency: "usd", at: now - 60 });
  // No credit: each buyer read is written down as not told (one mark each), so nothing is sent and each is seen.
  await startClosingCredit(folder, 0);
  const fieldsOf = async () => {
    const flat = (await redis.pipeline([["HGETALL", toldKey(folder)]]))[0] as unknown;
    if (!Array.isArray(flat)) return [] as string[];
    return flat.filter((_, i) => i % 2 === 0).map(String).sort();
  };

  part("A PayPal sale whose record is missing: the buyers read are handled, the round is not marked done");
  {
    await redis.pipeline([
      ["ZADD", `nl:ppsell:sales:${statsId}`, String(now - 60), KEPT, String(now - 30), LOST],
      ["SET", `nl:ppsell:paid:${KEPT}`, paid(KEPT, "kept@example.com")],
    ]);
    const told = await tellBuyers(store, E, day, "", Date.now() + 60_000);
    is("the buyer whose sale was read is handled now", await fieldsOf(), ["kept@example.com"]);
    is("the round is not done: the next run reads the PayPal buyers again", told.after, "");
    is("and the store is not said done", told.done, false);
  }

  part("A PayPal sale written for another store: the same");
  {
    await redis.pipeline([["SET", `nl:ppsell:paid:${LOST}`, JSON.stringify({ ...JSON.parse(paid(LOST, "other@example.com")), store: "x".repeat(32) })]]);
    const told = await tellBuyers(store, E, day, "", Date.now() + 60_000);
    is("not marked done while a sale belongs to another store", told.after, "");
  }

  part("Control: every sale read whole, the round goes on to the payments");
  {
    await redis.pipeline([["SET", `nl:ppsell:paid:${LOST}`, paid(LOST, "lost@example.com")]]);
    const told = await tellBuyers(store, E, day, "", Date.now() + 60_000);
    is("both PayPal buyers handled, once each", await fieldsOf(), ["kept@example.com", "lost@example.com"]);
    is("the round goes on (no Stripe account here, so it is done)", [told.after, told.done], ["start", true]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
