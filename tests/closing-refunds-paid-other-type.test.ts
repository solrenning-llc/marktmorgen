/**
 * Rule 30 next to Codex G's finding on #3120: a paid invoice-payment row is a payment made whatever its type, so a paid
 * row paid by a charge, a payment record or no payment the code can read leaves the member unknown (failed, tried again),
 * never settled as owed nothing. Rows that are not paid still prove nothing was paid, and the row order does not decide.
 */
import { giveBackUnused } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const DAY = Date.UTC(2026, 10, 6), SEC = DAY / 1000, SUB = "sub_GOtherType01", INV = "in_GOtherType01", PI = "pi_GOtherType01";
let listed: unknown[] = [];
let posts = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  if (path === "/v1/balance") return Response.json({ object: "balance", available: [{ amount: 100000, currency: "usd" }] });
  if (path === `/v1/invoices/${INV}`) return Response.json({ id: INV, payment_intent: null });
  if (path === "/v1/invoice_payments") return Response.json({ object: "list", has_more: false, data: listed });
  if (path === `/v1/payment_intents/${PI}`) return Response.json({ id: PI, latest_charge: { id: "ch_GOtherType01", amount: 1000, currency: "usd", amount_refunded: 0, disputed: false, balance_transaction: null } });
  if (path === "/v1/refunds" && init?.method === "POST") {
    posts++;
    const b = new URLSearchParams(String(init.body));
    return Response.json({ object: "refund", id: "re_GOtherType01", amount: Number(b.get("amount")), currency: "usd", payment_intent: PI, status: "succeeded" });
  }
  if (path === "/v1/refunds") return Response.json({ object: "list", data: [], has_more: false });
  throw Error("unexpected synthetic request");
}) as typeof fetch;

const row = (status: string, payment: unknown) => ({ id: `inpay_${status}`, invoice: INV, status, ...(payment === undefined ? {} : { payment }) });

async function seed(label: string) {
  redis.clear();
  posts = 0;
  const email = `ot-${label}@example.com`;
  await claimHandle(email, `got${label}`, "Other type refund", "");
  const store = { ...(await storeForEmail(email))!, stripeAccountId: "acct_GOther01" } as Store;
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: INV, amt: 1000, tot: 1000, cur: "usd", ps: SEC - 15 * 86400, pe: SEC + 15 * 86400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 30, "rcalls", 30],
  ]);
  return { store, folder };
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_other_type";
  const unread: [string, unknown][] = [
    ["charge", { type: "charge", charge: "ch_GOtherType01" }],
    ["record", { type: "payment_record", payment_record: "pr_GOtherType01" }],
    ["nopayment", undefined],
    ["nullpayment", null],
    ["intentobject", { type: "payment_intent", payment_intent: { id: 7 } }],
  ];
  for (const [label, payment] of unread) {
    listed = [row("paid", payment)];
    const { store, folder } = await seed(label);
    const first = await giveBackUnused(store, DAY, { final: true });
    is(`${label}: a paid row that names no readable intent fails, never settles none`, typeof first === "object" ? [first.failed, first.none, posts] : first, [1, 0, 0]);
    const [raw] = await redis.pipeline([["HGET", paidKey(folder), SUB]]);
    is(`${label}: its durable row stays unsettled`, JSON.parse(String(raw)).r ?? null, null);
  }
  for (const order of ["unread first", "readable first"]) {
    const rows = [row("paid", { type: "charge", charge: "ch_GOtherType01" }), row("paid", { type: "payment_intent", payment_intent: { id: PI } })];
    listed = order === "unread first" ? rows : rows.reverse();
    const { store } = await seed(order.split(" ")[0]);
    const got = await giveBackUnused(store, DAY, { final: true });
    is(`${order}: a readable paid intent is refunded once whatever the order`, typeof got === "object" ? [got.failed, got.done.map((x) => x.sub), posts] : got, [0, [SUB], 1]);
  }
  listed = [row("open", { type: "payment_intent", payment_intent: PI }), row("canceled", { type: "charge", charge: "ch_GOtherType01" })];
  const { store } = await seed("unpaid");
  const none = await giveBackUnused(store, DAY, { final: true });
  is("a complete list with no paid row still settles none", typeof none === "object" ? [none.failed, none.none, posts] : none, [0, 1, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
