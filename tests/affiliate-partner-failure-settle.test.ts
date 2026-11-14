/**
 * A partner's share that could not be written is retried, whichever way the
 * affiliate step ends (Claude 3's MÉDIO on #4413).
 *
 * noteSession works out the partners' shares first and, when that step fails,
 * throws its error once the affiliate step is done (`settle`), so the sweep
 * counts the order as failed and keeps it for its next run (HSETNX writes each
 * share once). A plain `return` on the code, bond and contact path would end a
 * sale no affiliate brought (most of them) quietly: the order would not be
 * counted as failed and the partner's share would never be written.
 *
 * Here the partner step fails on an order whose added product's price does not
 * read (orderLines throws UnknownReplyError), and every early exit of the
 * affiliate step must still reject: a bonded buyer whose affiliate was removed,
 * a buyer nobody brought, and a code typed while the program is switched off.
 */
import { noteSession } from "@/lib/affiliates";
import { rememberBuyer } from "@/lib/affiliate-bond";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "statsid12";
const ANA = "0123456789a4";
const PROMO = "promo_1TestPartnerFail1";

function shop(enabled = true): Store {
  return {
    handle: "harbor",
    name: "Harbor Kitchen",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    affiliates: { enabled, percent: 30, days: 30, rates: {}, payday: 0, hold: 0, lifetime: true, rule: "last" },
  } as unknown as Store;
}

const order = (id: string, email: string, code = false) => ({
  id,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: 1_760_000_000,
  amount_total: 5_000,
  amount_subtotal: 5_000,
  currency: "usd",
  total_details: { amount_tax: 0, amount_shipping: null },
  payment_intent: `pi_${id}`,
  // An added product whose price does not read: the partners' step cannot be worked out.
  metadata: { store: "harbor", product: "front", title: "Front", bump: "workbook", bump_cents: "not-cents" },
  customer_details: { email },
  ...(code ? { discounts: [{ coupon: "co_x", promotion_code: PROMO }] } : {}),
});

const person = (id: string, code: string, status: string) => JSON.stringify({ id, email: `${code}@example.com`, code, status, appliedAt: 1, decidedAt: 2, note: "" });

const outcome = (p: Promise<unknown>) => p.then(() => "resolved", (error: Error) => error.name);

async function credit(ref: string): Promise<unknown> {
  const [raw] = await redis.pipeline([["HGET", `nl:aff:${STATS}:sales`, ref]]);
  return typeof raw === "string" ? JSON.parse(raw).aff : null;
}

async function main(): Promise<void> {
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, ANA, person(ANA, "ana", "approved")],
    ["HSET", `nl:aff:${STATS}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${STATS}:promo`, PROMO, ANA],
  ]);
  await rememberBuyer(shop(), "lee@example.com", ANA, "last");
  await redis.pipeline([["HSET", `nl:aff:${STATS}:people`, ANA, person(ANA, "ana", "removed")]]);

  is("a bonded buyer whose affiliate was removed: the failed partner share keeps the order for the next run", await outcome(noteSession(shop(), order("cs_bond_removed", "lee@example.com"))), "UnknownReplyError");
  is("and nobody is credited", await credit("cs_bond_removed"), null);
  is("a buyer nobody brought: the failed partner share keeps the order for the next run", await outcome(noteSession(shop(), order("cs_nobody", "kai@example.com"))), "UnknownReplyError");
  is("a code typed while the program is off: the failed partner share keeps the order for the next run", await outcome(noteSession(shop(false), order("cs_off", "kai@example.com", true))), "UnknownReplyError");
  is("and nobody is credited through the code", await credit("cs_off"), null);
}

main().then(done, (error) => { console.error(error); process.exit(1); });
