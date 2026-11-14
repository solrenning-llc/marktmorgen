/**
 * A sale through an affiliate's link whose share, written onto the order when
 * the buyer started paying (`metadata[via_rate]`), cannot be read is not a 0%
 * sale (rule 24; Claude 5, round 30). Before, `Number(meta.via_rate) || 0`
 * wrote it down at 0% with HSETNX, once and for good: the affiliate was owed
 * their share and the book said nothing was earned. Now nothing is written,
 * neither paid nor zeroed: noteSession and noteCharge throw. A checkout is kept
 * by the sweep for its next run (failOrder) while it is inside the sweep's window;
 * a one-click offer's charge is only logged (lib/upsell.ts catches it), so its
 * commission is not written at all rather than written at 0%.
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
    total_details: { amount_tax: 0, amount_shipping: 0 },
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

  // The sibling (Claude 5's pre-review of round 30): each product ticked at checkout carries its own share
  // (`metadata[<bump>_rate]`) and what it was charged (`metadata[<bump>_cents]`), written beside the bump by every
  // writer (lib/store-checkout.ts, lib/cart-checkout.ts). One that does not read was skipped in silence, so its part
  // of the order was weighed at the front product's share and written down for good (HSETNX): a bump at 30% behind a
  // front product at 0% earned nothing. It follows the same rule as via_rate: nothing written, the commission waits.
  part("A product checked at checkout: its share and its price read, or nothing is written");
  // 10,000 cents in all, 4,000 of them the bump: 60% at the front share, 40% at the bump's.
  const bumped = (id: string, extra: Record<string, string>) => session(id, { via_rate: "20", bump: "ebook", ...extra });
  is("a bump at 30 behind a front at 20 is weighed: 20 × 0.6 + 30 × 0.4 = 24", [await outcome(() => noteSession(store, bumped("cs_bump30", { bump_cents: "4000", bump_rate: "30" }), new Map(), [])), (await sale("cs_bump30"))?.rate], ["written", 24]);
  is("a bump the creator left out (0) earns nothing on its part: 20 × 0.6 = 12", [await outcome(() => noteSession(store, bumped("cs_bump0", { bump_cents: "4000", bump_rate: "0" }), new Map(), [])), (await sale("cs_bump0"))?.rate], ["written", 12]);
  is("a free bump (0 cents) has no part to weigh: the front share stands", [await outcome(() => noteSession(store, bumped("cs_bumpfree", { bump_cents: "0", bump_rate: "30" }), new Map(), [])), (await sale("cs_bumpfree"))?.rate], ["written", 20]);
  const badBump: [string, Record<string, string>][] = [
    ["share missing", { bump_cents: "4000" }],
    ["share in words", { bump_cents: "4000", bump_rate: "thirty" }],
    ["share past the most", { bump_cents: "4000", bump_rate: "91" }],
    ["share negative", { bump_cents: "4000", bump_rate: "-30" }],
    ["price missing", { bump_rate: "30" }],
    ["price in words", { bump_cents: "forty", bump_rate: "30" }],
    ["price negative", { bump_cents: "-4000", bump_rate: "30" }],
    ["price not whole", { bump_cents: "40.5", bump_rate: "30" }],
  ];
  for (const [what, meta] of badBump) {
    const ref = `cs_bb${what.replace(/[^a-z]/g, "").slice(0, 16)}`;
    is(`a bump's ${what}: thrown, and no sale on the book at the front share`, [await outcome(() => noteSession(store, bumped(ref, meta), new Map(), [])), await sale(ref)], ["thrown", null]);
  }

  done();
}

void main();
