/**
 * A sale through an affiliate's link whose share, written onto the order when
 * the buyer started paying (`metadata[via_rate]`), cannot be read is not a 0%
 * sale (rule 24; Claude 5, round 30). Before, `Number(meta.via_rate) || 0`
 * wrote it down at 0% with HSETNX, once and for good: the affiliate was owed
 * their share and the book said nothing was earned. Now nothing is written,
 * neither paid nor zeroed: noteSession and noteCharge throw, so the checkout
 * sweep keeps the order for its next run (failOrder), and the commission waits.
 *
 * Every writer of `via_rate` writes `String(rate)` beside `via` (lib/store-checkout.ts,
 * lib/cart-checkout.ts, lib/calls.ts, lib/upsell.ts, lib/stats.ts), "0" included, so
 * a missing or garbled one is not an older record: it is not known.
 */
import { noteCharge, noteSession } from "@/lib/affiliates";
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
  const session = (id: string, meta: Record<string, string>) => ({
    id,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: 1760000000,
    amount_total: 10000,
    amount_subtotal: 10000,
    currency: "usd",
    payment_intent: `pi_${id.slice(3)}`,
    metadata: { store: "harbor", product: "course", title: "Course", via: affiliate, ...meta },
    customer_details: { email: "buyer@example.com" },
  });
  const charge = (id: string, meta: Record<string, string>) => ({
    id,
    status: "succeeded",
    amount: 5000,
    currency: "usd",
    receipt_email: "buyer@example.com",
    created: 1760000000,
    metadata: { store: "harbor", product: "course", title: "Course", via: affiliate, ...meta },
  });

  part("A share that reads is written as it was");
  is("20 is written at 20", [await outcome(() => noteSession(store, session("cs_rate20", { via_rate: "20" }), new Map(), [])), (await sale("cs_rate20"))?.rate], ["written", 20]);
  is("0 is a share a link can carry (only the products added earn), written at 0", [await outcome(() => noteSession(store, session("cs_rate0", { via_rate: "0" }), new Map(), [])), (await sale("cs_rate0"))?.rate], ["written", 0]);
  is("a one-click offer's 15 is written at 15", [await outcome(() => noteCharge(store, charge("pi_rate15", { via_rate: "15" }))), (await sale("pi_rate15"))?.rate], ["written", 15]);

  part("A share that does not read is not known: nothing written, neither paid nor zeroed");
  const garbled: [string, Record<string, string>][] = [
    ["missing", {}],
    ["empty", { via_rate: "" }],
    ["words", { via_rate: "twenty" }],
    ["negative", { via_rate: "-5" }],
    ["past the most a programme can give", { via_rate: "91" }],
    ["past exact", { via_rate: "1e999" }],
    ["not a number", { via_rate: "NaN" }],
  ];
  for (const [what, meta] of garbled) {
    const ref = `cs_bad${what.replace(/[^a-z]/g, "").slice(0, 12)}`;
    is(`a checkout's share ${what}: thrown, and no 0% sale on the book`, [await outcome(() => noteSession(store, session(ref, meta), new Map(), [])), await sale(ref)], ["thrown", null]);
    const pi = `pi_bad${what.replace(/[^a-z]/g, "").slice(0, 12)}`;
    is(`a one-click offer's share ${what}: thrown, and no 0% sale on the book`, [await outcome(() => noteCharge(store, charge(pi, meta))), await sale(pi)], ["thrown", null]);
  }

  part("Read again once it reads, it is written once, at its share");
  is("the same order, its share read, is written at 20", [await outcome(() => noteSession(store, session("cs_badmissing", { via_rate: "20" }), new Map(), [])), (await sale("cs_badmissing"))?.rate], ["written", 20]);

  done();
}

void main();
