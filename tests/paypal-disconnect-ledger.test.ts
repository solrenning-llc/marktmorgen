/**
 * The buyer ledger after PayPal is disconnected (#4398; lib/segments.ts
 * buyerLedger, ledgerReadingUnits). The PayPal sales a store kept are read
 * whether or not PayPal is still connected (lib/stats.ts readPaidSales); the
 * refunds written down for them are read with them, so a purchase refunded in
 * full never comes back as a buyer with its full amount, and what the reading
 * is counted for covers those refunds too. Synthetic: a Redis stub and an
 * empty Stripe stand-in.
 */
import { buyerLedger, ledgerReadingUnits } from "@/lib/segments";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "k".repeat(32);
const ORDER = "7AB12345CD6789012";
const CAPTURE = "9XY12345ZW6789012";
const AT = Math.floor(Date.parse("2026-11-01T12:00:00Z") / 1000);

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  return new Response(JSON.stringify({ data: [], has_more: false }));
}) as typeof fetch;

const base = {
  sid: "sidpaypal001",
  handle: "potter",
  previousHandles: [],
  releasedHandles: [],
  statsId: SID,
  listId: "listpp01",
  currency: "usd",
  stripeAccountId: "acct_test_ppdisconnect",
  catalog: { id: null, head: [], items: [{ id: "p1", kind: 0, options: [] }], inline: [{ id: "p1", title: "Clay Basics", options: [] }] },
} as unknown as Store;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_ppdisconnect_only_a_stand_in";
  const seed = async () => {
    redis.clear();
    await redis.pipeline([
      ["SET", `nl:ppsell:paid:${ORDER}`, JSON.stringify({ store: SID, order: ORDER, capture: CAPTURE, email: "pat@example.com", product: "p1", cents: 10000, currency: "usd", at: AT, handle: "potter" })],
      ["ZADD", `nl:ppsell:sales:${SID}`, String(AT), ORDER],
      // Refunded in full, written down before PayPal was disconnected.
      ["ZADD", `nl:ppsell:refunded:${SID}`, String(AT + 3600), ORDER],
    ]);
  };

  part("PayPal connected: the refund is taken off");
  await seed();
  const on = await buyerLedger({ ...base, paypalSeller: { merchant: "MERCHANT0001" } } as unknown as Store);
  is("a PayPal purchase refunded in full is not a buyer", [on.buyers.get("pat@example.com")?.cents ?? 0, on.partial], [0, false]);

  part("PayPal disconnected: the sale is still read, and so is its refund");
  await seed();
  const off = await buyerLedger({ ...base } as Store);
  is("an already refunded PayPal purchase does not come back as a buyer with $100 (#4398)", off.buyers.get("pat@example.com")?.cents ?? 0, 0);
  is("and the reading is complete", off.partial, false);

  part("What the reading is counted for covers the refunds read, connected or not");
  await seed();
  const connected = await ledgerReadingUnits({ ...base, paypalSeller: { merchant: "MERCHANT0001" } } as unknown as Store);
  await seed();
  const disconnected = await ledgerReadingUnits({ ...base } as Store);
  is("the same units with PayPal disconnected as connected, since the same records are read (#4398)", disconnected, connected);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
