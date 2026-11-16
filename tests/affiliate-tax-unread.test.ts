/**
 * The buyer's sales tax is never a share of the sale (receipts hunt, Claude 7). An affiliate's or a
 * partner's share is taken of what was paid before tax: `amount_total` less `total_details.amount_tax`
 * (lib/affiliates.ts, noteSession). Before, a tax figure that did not read (missing, null, not a whole
 * number) was taken as 0, so the share was written on the tax as well, and an amount_total that did not
 * read was taken as 0, so the share was written at nothing; both with HSETNX, once and for good.
 * lib/share-settle.ts already reads the same two figures exactly (goodsPaid returns null). Now
 * noteSession throws UnknownReplyError before anything is written, and the sweep keeps the order for
 * its next run (failOrder), as it does for a share that does not read (affiliate-via-rate-unknown).
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
  // $100 for the course, $8 of sales tax added on top: $108 charged.
  const session = (id: string, figures: Record<string, unknown>) => ({
    id,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: 1760000000,
    amount_subtotal: 10000,
    currency: "usd",
    payment_intent: `pi_${id.slice(3)}`,
    metadata: { store: "harbor", product: "course", title: "Course", via: affiliate, via_rate: "20" },
    customer_details: { email: "buyer@example.com" },
    ...figures,
  });

  part("Tax that reads comes off: the share is of what was paid before tax");
  is(
    "$108 with $8 of tax: base $100, total $108",
    [await outcome(() => noteSession(store, session("cs_taxread", { amount_total: 10800, total_details: { amount_tax: 800 } }), new Map(), [])), (await sale("cs_taxread"))?.base, (await sale("cs_taxread"))?.total],
    ["written", 10000, 10800],
  );
  is(
    "no tax at all (0): base is the whole",
    [await outcome(() => noteSession(store, session("cs_taxzero", { amount_total: 10000, total_details: { amount_tax: 0 } }), new Map(), [])), (await sale("cs_taxzero"))?.base],
    ["written", 10000],
  );

  part("Tax or total that does not read is not 0: nothing written, the order waits");
  const unread: [string, Record<string, unknown>][] = [
    ["tax figures missing", { amount_total: 10800 }],
    ["tax figures null", { amount_total: 10800, total_details: null }],
    ["tax missing", { amount_total: 10800, total_details: {} }],
    ["tax null", { amount_total: 10800, total_details: { amount_tax: null } }],
    ["tax in words", { amount_total: 10800, total_details: { amount_tax: "800" } }],
    ["tax not whole", { amount_total: 10800, total_details: { amount_tax: 800.5 } }],
    ["tax negative", { amount_total: 10800, total_details: { amount_tax: -800 } }],
    ["tax above the total", { amount_total: 10800, total_details: { amount_tax: 10900 } }],
    ["total missing", { total_details: { amount_tax: 800 } }],
    ["total null", { amount_total: null, total_details: { amount_tax: 800 } }],
    ["total negative", { amount_total: -10800, total_details: { amount_tax: 800 } }],
  ];
  for (const [what, figures] of unread) {
    const ref = `cs_un${what.replace(/[^a-z]/g, "").slice(0, 20)}`;
    is(`${what}: thrown, and no sale on the book`, [await outcome(() => noteSession(store, session(ref, figures), new Map(), [])), await sale(ref)], ["thrown", null]);
  }

  part("Read again once it reads, it is written once, before tax");
  is(
    "the same order, its tax read, is written at base $100",
    [await outcome(() => noteSession(store, session("cs_untaxmissing", { amount_total: 10800, total_details: { amount_tax: 800 } }), new Map(), [])), (await sale("cs_untaxmissing"))?.base],
    ["written", 10000],
  );

  done();
}

void main();
