/**
 * An order with products ticked at checkout, weighed only on a subtotal
 * Stripe gives (CX-123 rule 24, unknown is never zero). noteSession
 * (lib/affiliates.ts) weighs each ticked product's share by its part of
 * `amount_subtotal`; a subtotal that did not read became 0, the weighing was
 * skipped, and the whole order was written down for good (HSETNX) at the
 * front product's share, as if nothing had been ticked. Now it throws before
 * anything is written, as a ticked product's price or share that does not
 * read already does, and the commission waits.
 */
import { noteSession } from "@/lib/affiliates";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";


const affiliate = "aaaaaaaaaaaa";
const store = {
  sid: "storeid1",
  handle: "harbor",
  name: "Harbor",
  email: "owner@example.com",
  statsId: "statsid1",
  currency: "usd",
  previousHandles: [],
  releasedHandles: [],
  affiliates: { ...NO_AFFILIATES, enabled: true, percent: 20 },
} as unknown as Store;

async function sale(ref: string): Promise<Record<string, unknown> | null> {
  const [raw] = (await redis.pipeline([["HGET", "nl:aff:statsid1:sales", ref]])) as unknown[];
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

async function outcome(run: () => Promise<void>): Promise<string> {
  try {
    await run();
    return "written";
  } catch {
    return "thrown";
  }
}

async function main(): Promise<void> {
  redis.clear();
  await redis.pipeline([
    ["HSET", "nl:aff:statsid1:people", affiliate, JSON.stringify({ id: affiliate, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 1, note: "" })],
  ]);
  const session = (id: string, subtotal: unknown, meta: Record<string, string>) => ({
    id,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: 1760000000,
    amount_total: 10000,
    amount_subtotal: subtotal,
    currency: "usd",
    total_details: { amount_tax: 0, amount_shipping: 0 },
    payment_intent: `pi_${id.slice(3)}`,
    metadata: { store: "harbor", product: "course", title: "Course", via: affiliate, via_rate: "20", ...meta },
    customer_details: { email: "buyer@example.com" },
  });
  // 10,000 cents in all, 4,000 of them a bump the creator left out (0%): 20 × 0.6 = 12.
  const bump = { bump: "ebook", bump_cents: "4000", bump_rate: "0" };

  part("A subtotal that does not read, with a product ticked: thrown, nothing on the book");
  for (const [what, subtotal] of [["missing", undefined], ["null", null], ["text", "10000"], ["a fraction", 10000.5], ["negative", -10000]] as const) {
    const ref = `cs_sub_${what.replace(/\W/g, "")}`;
    is(`subtotal ${what}: thrown, and no sale at the front share`, [await outcome(() => noteSession(store, session(ref, subtotal, bump), new Map(), [])), await sale(ref)], ["thrown", null]);
  }

  part("What reads is unchanged");
  is("the same order, its subtotal read, is weighed: 12", [await outcome(() => noteSession(store, session("cs_sub_read", 10000, bump), new Map(), [])), (await sale("cs_sub_read"))?.rate], ["written", 12]);
  is("no product ticked: the subtotal is not needed, the front share stands", [await outcome(() => noteSession(store, session("cs_sub_none", undefined, {}), new Map(), [])), (await sale("cs_sub_none"))?.rate], ["written", 20]);

  done();
}

void main();
