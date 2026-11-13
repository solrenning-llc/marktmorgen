/**
 * An affiliate's own purchase is the same person under their payout address,
 * and the creator buying in their own store through an affiliate's link is not
 * a sale either.
 *
 * isSelf compared the buyer only with the address the affiliate joined with.
 * The lead rule (lib/affiliate-leads.ts isOwn) and sameInboxAsAnother already
 * take the PayPal address commissions are paid to, and the store's own address,
 * as the same person. So an affiliate could buy through their own link with the
 * address they are paid at and earn on their own purchase, and an affiliate
 * earned on the creator's test purchase. Each line must say `self`.
 */
import { creditPayPalSale, noteSession } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "statsid7";
const AFF = "0123456789ef";

function shop(): Store {
  return {
    handle: "harbor",
    name: "Harbor Kitchen",
    email: "Owner@Example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    affiliates: { enabled: true, percent: 20, days: 30, rates: {}, payday: 0, hold: 0 },
  } as unknown as Store;
}

async function seed(): Promise<void> {
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, AFF, JSON.stringify({ id: AFF, email: "ana@example.com", paypal: "ana.pay@other.com", code: "ana", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${STATS}:codes`, "ana", AFF],
  ]);
}

const order = (id: string, email: string) => ({
  id,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: 1_760_000_000,
  amount_total: 10_000,
  amount_subtotal: 10_000,
  currency: "usd",
  total_details: { amount_tax: 0 },
  payment_intent: `pi_${id}`,
  metadata: { store: "harbor", product: "front", title: "Front", via: AFF, via_rate: "20" },
  customer_details: { email },
});

async function selfOf(ref: string): Promise<unknown> {
  const [raw] = await redis.pipeline([["HGET", `nl:aff:${STATS}:sales`, ref]]);
  return typeof raw === "string" ? JSON.parse(raw).self : `missing: ${String(raw)}`;
}

async function main(): Promise<void> {
  await seed();
  await noteSession(shop(), order("cs_join", "ana+x@example.com"));
  is("the address they joined with is their own purchase", await selfOf("cs_join"), true);
  await noteSession(shop(), order("cs_pay", "ANA.PAY@other.com"));
  is("the address they are paid at is their own purchase", await selfOf("cs_pay"), true);
  await noteSession(shop(), order("cs_owner", "owner+test@example.com"));
  is("the creator buying in their own store earns the affiliate nothing", await selfOf("cs_owner"), true);
  await noteSession(shop(), order("cs_other", "buyer@example.com"));
  is("somebody else is a sale", await selfOf("cs_other"), false);

  await creditPayPalSale(shop(), { order: "PP1", capture: "CAP1", at: 1_760_000_000, product: "front", cents: 10_000, currency: "USD", email: "ana.pay@other.com", via: { aff: AFF, rate: 20 } } as never, "Front");
  is("PayPal: the address they are paid at is their own purchase", await selfOf("paypal:PP1"), true);
}

main().then(done, (error) => { console.error(error); process.exit(1); });
