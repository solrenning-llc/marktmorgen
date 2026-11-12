/**
 * A program switched off credits nobody through a code.
 *
 * The checkout sweep writes affiliate sales only while the program is on
 * (affiliatesOn), and a PayPal sale only credits an affiliate while it is on;
 * a bond and a contact need it on too. noteSession, which the thanks page calls
 * without that check, still credited the affiliate a discount code was given
 * to, at the program's share, after the creator switched the program off: what
 * the store owed depended on whether the buyer looked at the thanks page.
 */
import { noteSession } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "statsid10";
const BEN = "0123456789be";
const PROMO = "promo_1TestProgramOff01";

function shop(enabled: boolean): Store {
  return {
    handle: "harbor",
    name: "Harbor Kitchen",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    affiliates: { enabled, percent: 30, days: 30, rates: {}, payday: 0, hold: 0 },
  } as unknown as Store;
}

const order = (id: string) => ({
  id,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: 1_760_000_000,
  amount_total: 5_000,
  amount_subtotal: 5_000,
  currency: "usd",
  total_details: { amount_tax: 0 },
  payment_intent: `pi_${id}`,
  metadata: { store: "harbor", product: "front", title: "Front" },
  customer_details: { email: "kai@example.com" },
  discounts: [{ coupon: "co_x", promotion_code: PROMO }],
});

async function line(ref: string): Promise<unknown> {
  const [raw] = await redis.pipeline([["HGET", `nl:aff:${STATS}:sales`, ref]]);
  return typeof raw === "string" ? JSON.parse(raw).aff : null;
}

async function main(): Promise<void> {
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, BEN, JSON.stringify({ id: BEN, email: "ben@example.com", code: "ben", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${STATS}:codes`, "ben", BEN],
    ["HSET", `nl:aff:${STATS}:promo`, PROMO, BEN],
  ]);
  await noteSession(shop(true), order("cs_on"));
  is("on: the code credits Ben", await line("cs_on"), BEN);
  await noteSession(shop(false), order("cs_off"));
  is("switched off: the code credits nobody", await line("cs_off"), null);
}

main().then(done, (error) => { console.error(error); process.exit(1); });
