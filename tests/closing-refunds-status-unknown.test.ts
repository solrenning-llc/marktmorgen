/**
 * Rule 24 on Codex G's residual finding on #3120 (review 5816959051): an invoice-payment row whose status is missing,
 * null, not a string or a value Stripe does not document (e.g. "processing") proves nothing about whether this invoice
 * was paid. Its member is counted failed and tried again, never settled as owed nothing, and a later reply that reads
 * "paid" on the same intent still reaches the member and refunds once. Only "paid" decides paid; only the documented
 * non-paid values ("open", "canceled") decide not paid. A readable paid intent of this invoice is still found whatever
 * the row order.
 *
 * Codex G's focal return on #3120 (review 5816998291): "failed" is not one of the InvoicePayment status values Stripe
 * documents (open, paid, canceled: https://docs.stripe.com/api/invoice-payment/object, read 08/11/2026), so it is unknown
 * like any other out-of-schema value: a complete list with a readable intent and status "failed" fails (failed=1, none=0,
 * nothing POSTed), leaves no r on the durable row, and a later "paid" on the same intent refunds once.
 */
import { giveBackUnused } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const DAY = Date.UTC(2026, 10, 6), SEC = DAY / 1000, SUB = "sub_GStatusUnk01", INV = "in_GStatusUnk01", PI = "pi_GStatusUnk01";
let listed: unknown[] = [];
let posts = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  if (path === "/v1/balance") return Response.json({ object: "balance", available: [{ amount: 100000, currency: "usd" }] });
  if (path === `/v1/invoices/${INV}`) return Response.json({ id: INV, payment_intent: null });
  if (path === "/v1/invoice_payments") return Response.json({ object: "list", has_more: false, data: listed });
  if (path === `/v1/payment_intents/${PI}`) return Response.json({ id: PI, latest_charge: { id: "ch_GStatusUnk01", amount: 1000, currency: "usd", amount_refunded: 0, disputed: false, balance_transaction: null } });
  if (path === "/v1/refunds" && init?.method === "POST") {
    posts++;
    const b = new URLSearchParams(String(init.body));
    return Response.json({ object: "refund", id: "re_GStatusUnk01", amount: Number(b.get("amount")), currency: "usd", payment_intent: PI, status: "succeeded" });
  }
  if (path === "/v1/refunds") return Response.json({ object: "list", data: [], has_more: false });
  throw Error("unexpected synthetic request");
}) as typeof fetch;

const intent = { type: "payment_intent", payment_intent: PI };
/** A row of this invoice; `status` absent when undefined, so "missing" is a row with no status key at all. */
const row = (label: string, status: unknown, payment: unknown = intent) => ({ id: `inpay_${label}`, invoice: INV, ...(status === undefined ? {} : { status }), payment });

async function seed(label: string) {
  redis.clear();
  posts = 0;
  const email = `su-${label}@example.com`;
  await claimHandle(email, `gsu${label}`, "Status unknown refund", "");
  const store = { ...(await storeForEmail(email))!, stripeAccountId: "acct_GStatus01" } as Store;
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: INV, amt: 1000, tot: 1000, cur: "usd", ps: SEC - 15 * 86400, pe: SEC + 15 * 86400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 30, "rcalls", 30],
  ]);
  return { store, folder };
}

const counts = (r: Awaited<ReturnType<typeof giveBackUnused>>) => (typeof r === "object" ? [r.failed, r.none, posts] : r);
async function durable(folder: string) {
  const [raw] = await redis.pipeline([["HGET", paidKey(folder), SUB]]);
  return JSON.parse(String(raw)).r ?? null;
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_status_unknown";
  // Codex G's scenario: a complete reply for the right invoice, a readable intent, a status that is not known.
  const unknown: [string, unknown][] = [
    ["missing", undefined],
    ["null", null],
    ["processing", "processing"],
    ["number", 7],
    ["uppercase", "PAID"],
    // Codex G's focal return (review 5816998291): outside the documented InvoicePayment status enum, so not proof of none.
    ["failed", "failed"],
  ];
  for (const [label, status] of unknown) {
    listed = [row(label, status)];
    const { store, folder } = await seed(label);
    is(`${label}: an unknown status fails, never settles none`, counts(await giveBackUnused(store, DAY, { final: true })), [1, 0, 0]);
    is(`${label}: its durable row stays unsettled`, await durable(folder), null);
    listed = [row(label, "paid")];
    const next = await giveBackUnused(store, DAY, { final: true });
    is(`${label}: a later paid reply on the same intent still reaches and refunds the member once`, typeof next === "object" ? [next.done.map((x) => x.sub), posts] : next, [[SUB], 1]);
  }

  // An unknown status is unknown whatever its payment reads as: it never proves the absence of a payment.
  listed = [row("unread", "processing", { type: "charge", charge: "ch_GStatusUnk01" })];
  const unread = await seed("unread");
  is("unknown status on a payment of another type: fails, never settles none", counts(await giveBackUnused(unread.store, DAY, { final: true })), [1, 0, 0]);
  is("unknown status on a payment of another type: its durable row stays unsettled", await durable(unread.folder), null);

  // A readable paid intent of this invoice is found whatever the order, next to a row of unknown status.
  for (const order of ["unknown first", "paid first"]) {
    const rows = [row("odd", "processing"), row("good", "paid")];
    listed = order === "unknown first" ? rows : rows.reverse();
    const { store } = await seed(order.split(" ")[0]);
    const got = await giveBackUnused(store, DAY, { final: true });
    is(`${order}: the readable paid intent is refunded once`, typeof got === "object" ? [got.failed, got.done.map((x) => x.sub), posts] : got, [0, [SUB], 1]);
  }

  // Controls: a complete list whose rows all carry a documented non-paid status still settles none. ("failed" is not
  // documented and is checked above as unknown, Codex G's focal return on #3120.)
  for (const status of ["open", "canceled"]) {
    listed = [row(status, status)];
    const { store } = await seed(status);
    is(`control: a complete list with only "${status}" settles none`, counts(await giveBackUnused(store, DAY, { final: true })), [0, 1, 0]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
