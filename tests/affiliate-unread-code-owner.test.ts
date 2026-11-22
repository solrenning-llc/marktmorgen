/**
 * An unreadable record of a code's owner credits nobody on that run, never the bond or the lead (Claude 6's MEDIUM on
 * #4413, rule 24).
 *
 * noteSession now lets the sale go on to the buyer's bond, then to the confirmed lead, when the code's owner is not
 * approved. It read the owner with readAffiliate, which answers null for a lost or garbled reply, so an unreadable
 * record was taken for "not approved": the bond's affiliate was credited, once and for good (HSETNX), and the code's
 * real owner never was. Now the owner is read exactly: an unknown reply throws, the sweep keeps the order and reads it
 * again on its next run, and the real owner is credited then.
 *
 * Synthetic: the in-memory Redis stand-in; its pipeline cuts the first read of the code owner's record short.
 */
import { noteSession } from "@/lib/affiliates";
import { rememberBuyer } from "@/lib/affiliate-bond";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "statsid12";
const ANA = "0123456789a4";
const BEN = "0123456789b4";
const PROMO = "promo_1TestUnreadOwner1";

function shop(): Store {
  return {
    handle: "harbor",
    name: "Harbor Kitchen",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 0, hold: 0, lifetime: true, rule: "last", bonds: true },
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

const person = (id: string, code: string) => JSON.stringify({ id, email: `${code}@example.com`, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });

async function credit(ref: string): Promise<unknown> {
  const [raw] = await redis.pipeline([["HGET", `nl:aff:${STATS}:sales`, ref]]);
  if (typeof raw !== "string") return null;
  const v = JSON.parse(raw);
  return [v.aff, v.how];
}

async function main(): Promise<void> {
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, ANA, person(ANA, "ana"), BEN, person(BEN, "ben")],
    ["HSET", `nl:aff:${STATS}:codes`, "ana", ANA, "ben", BEN],
    ["HSET", `nl:aff:${STATS}:promo`, PROMO, BEN],
  ]);
  await rememberBuyer(shop(), "lee@example.com", ANA, "last");

  const real = redis.pipeline.bind(redis);
  let cut = 1;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const hit = commands.findIndex((c) => c[0] === "HGET" && c[1] === `nl:aff:${STATS}:people` && c[2] === BEN);
    if (hit >= 0 && cut > 0) {
      cut -= 1;
      const replies = (await real(commands)) as unknown[];
      replies[hit] = undefined;
      return replies;
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await noteSession(shop(), order("cs_cut", "lee@example.com")).catch(() => null);
    is("the run whose read of the code's owner was cut credits nobody", await credit("cs_cut"), null);
    await noteSession(shop(), order("cs_cut", "lee@example.com")).catch(() => null);
    is("the next run credits the code's real owner, never the bond", await credit("cs_cut"), [BEN, "code"]);
  } finally {
    redis.pipeline = real;
  }
}

main().then(done, (error) => { console.error(error); process.exit(1); });
