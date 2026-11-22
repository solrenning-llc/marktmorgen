/**
 * A code given to an affiliate the creator has since removed does not take the
 * sale away from the affiliate the buyer is kept with.
 *
 * noteSession reads, in order, the click, the code typed, the buyer's bond and
 * the confirmed lead. A code whose affiliate was removed (removing somebody
 * does not take back the codes given to them) stopped the whole chain, so a
 * bonded buyer typing that code credited nobody, where a code given to nobody
 * would have left the sale to the bond. On first click a removed affiliate's
 * click already leaves the sale to the one who brought the buyer back
 * (attributedAffiliate); a removed code's owner now does the same.
 */
import { noteSession } from "@/lib/affiliates";
import { rememberBuyer } from "@/lib/affiliate-bond";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "statsid11";
const ANA = "0123456789a3";
const BEN = "0123456789b3";
const PROMO = "promo_1TestRemovedCode1";

function shop(): Store {
  return {
    handle: "harbor",
    name: "Harbor Kitchen",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 0, hold: 0, lifetime: true, rule: "last" },
  } as unknown as Store;
}

const order = (id: string, email: string) => ({
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
  customer_details: { email },
  discounts: [{ coupon: "co_x", promotion_code: PROMO }],
});

const person = (id: string, code: string, status: string) => JSON.stringify({ id, email: `${code}@example.com`, code, status, appliedAt: 1, decidedAt: 2, note: "" });

async function credit(ref: string): Promise<unknown> {
  const [raw] = await redis.pipeline([["HGET", `nl:aff:${STATS}:sales`, ref]]);
  if (typeof raw !== "string") return null;
  const v = JSON.parse(raw);
  return [v.aff, v.how];
}

async function main(): Promise<void> {
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, ANA, person(ANA, "ana", "approved"), BEN, person(BEN, "ben", "removed")],
    ["HSET", `nl:aff:${STATS}:codes`, "ana", ANA, "ben", BEN],
    ["HSET", `nl:aff:${STATS}:promo`, PROMO, BEN],
  ]);
  await rememberBuyer(shop(), "lee@example.com", ANA, "last");
  await noteSession(shop(), order("cs_bonded", "lee@example.com"));
  is("a removed affiliate's code leaves the sale to the bond", await credit("cs_bonded"), [ANA, "buyer"]);
  await noteSession(shop(), order("cs_nobody", "kai@example.com"));
  is("and with no bond it still credits nobody", await credit("cs_nobody"), null);
  await redis.pipeline([["HSET", `nl:aff:${STATS}:people`, BEN, person(BEN, "ben", "approved")]]);
  await noteSession(shop(), order("cs_code", "lee@example.com"));
  is("an approved affiliate's code still beats the bond", await credit("cs_code"), [BEN, "code"]);
}

main().then(done, (error) => { console.error(error); process.exit(1); });
