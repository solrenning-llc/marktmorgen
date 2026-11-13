/**
 * A paid checkout whose amount, tax or currency cannot be read is not a sale of
 * $0, of no tax or in US dollars (rule 24: unknown fails, never zero). Before,
 * noteSession read a missing `amount_total` as 0 and a missing
 * `total_details.amount_tax` as 0, and a missing `currency` as "usd", and wrote
 * the sale down once and for good (HSETNX): the affiliate's commission was set
 * at nothing, or worked out on the buyer's tax as if it were the price, or
 * counted in the wrong money. noteCharge read a missing `amount` as 0 the same
 * way. Now nothing is written and the call throws: the sweep keeps the order
 * for its next run (failOrder), and the same order read whole is written once.
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
  const session = (id: string, change: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      id,
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      created: 1760000000,
      amount_total: 12000,
      amount_subtotal: 10000,
      total_details: { amount_tax: 2000, amount_discount: 0, amount_shipping: 0 },
      currency: "eur",
      payment_intent: `pi_${id.slice(3)}`,
      metadata: { store: "harbor", product: "course", title: "Course", via: affiliate, via_rate: "20" },
      customer_details: { email: "buyer@example.com" },
    };
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) delete row[key];
      else row[key] = value;
    }
    return row;
  };
  const charge = (id: string, change: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      id,
      status: "succeeded",
      amount: 5000,
      currency: "eur",
      receipt_email: "buyer@example.com",
      created: 1760000000,
      metadata: { store: "harbor", product: "course", title: "Course", via: affiliate, via_rate: "15" },
    };
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) delete row[key];
      else row[key] = value;
    }
    return row;
  };

  part("A checkout that reads whole is written as it was");
  {
    const result = await outcome(() => noteSession(store, session("cs_whole", {}) as never, new Map(), []));
    const row = await sale("cs_whole");
    is("written, the tax taken out of the base, in its own money", [result, row?.total, row?.base, row?.currency, row?.rate], ["written", 12000, 10000, "eur", 20]);
  }
  {
    const result = await outcome(() => noteSession(store, session("cs_notax", { amount_total: 10000, total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 } }) as never, new Map(), []));
    is("a sale with a tax of 0 that Stripe says is 0 is written at its whole base", [result, (await sale("cs_notax"))?.base], ["written", 10000]);
  }
  is("a one-click offer that reads whole is written as it was", [await outcome(() => noteCharge(store, charge("pi_whole", {}))), (await sale("pi_whole"))?.total, (await sale("pi_whole"))?.currency], ["written", 5000, "eur"]);

  part("A checkout's amount, tax or money that does not read: nothing written, neither $0 nor untaxed nor in dollars");
  const bad: [string, Record<string, unknown>][] = [
    ["amount missing", { amount_total: undefined }],
    ["amount null", { amount_total: null }],
    ["amount as text", { amount_total: "12000" }],
    ["amount negative", { amount_total: -12000 }],
    ["amount not whole", { amount_total: 120.5 }],
    ["tax missing", { total_details: undefined }],
    ["tax null", { total_details: null }],
    ["tax amount missing", { total_details: { amount_discount: 0 } }],
    ["tax amount as text", { total_details: { amount_tax: "2000" } }],
    ["tax past the amount", { total_details: { amount_tax: 20000 } }],
    ["money missing", { currency: undefined }],
    ["money in capitals", { currency: "EUR" }],
  ];
  for (const [what, change] of bad) {
    const ref = `cs_bad${what.replace(/[^a-z]/g, "").slice(0, 16)}`;
    is(`a checkout's ${what}: thrown, and nothing on the book`, [await outcome(() => noteSession(store, session(ref, change) as never, new Map(), [])), await sale(ref)], ["thrown", null]);
  }
  const badCharge: [string, Record<string, unknown>][] = [
    ["amount missing", { amount: undefined }],
    ["amount as text", { amount: "5000" }],
    ["amount negative", { amount: -5000 }],
    ["money missing", { currency: undefined }],
  ];
  for (const [what, change] of badCharge) {
    const ref = `pi_bad${what.replace(/[^a-z]/g, "").slice(0, 16)}`;
    is(`a one-click offer's ${what}: thrown, and nothing on the book`, [await outcome(() => noteCharge(store, charge(ref, change))), await sale(ref)], ["thrown", null]);
  }

  part("Read again once it reads whole, it is written once, at its amount");
  is("the same order, its amount read, is written at 12,000", [await outcome(() => noteSession(store, session("cs_badamountmissing", {}) as never, new Map(), [])), (await sale("cs_badamountmissing"))?.total], ["written", 12000]);
  is("the same offer, its amount read, is written at 5,000", [await outcome(() => noteCharge(store, charge("pi_badamountmissing", {}))), (await sale("pi_badamountmissing"))?.total], ["written", 5000]);

  done();
}

void main();
