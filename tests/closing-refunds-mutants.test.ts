/**
 * Mutation testing of lib/closing-refunds.ts (Claude 7, 13/11/2026): each case
 * kills a mutant that survived every test importing the module. When a store
 * closes, each member gets back the unused part of what they paid: a refund
 * already made for an invoice must be found exactly (never another invoice's,
 * never a failed one, never an amount that does not read), the settled cost is
 * rounded up, and the payment refunded is the invoice's own.
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts.
 */
import { giveBackUnused, priorRefund, refundState, settledCost, unusedSummary } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const INV = "in_MutClosing01";
const PI = "pi_MutClosing01";
const refund = (over: Record<string, unknown> = {}) => ({ object: "refund", id: "re_MutClosing01", amount: 500, currency: "usd", payment_intent: PI, status: "succeeded", metadata: { closing_refund: INV }, ...over });
const list = (data: unknown[], has_more: unknown = false) => ({ object: "list", data, has_more });
const prior = (data: unknown[], has_more: unknown = false) => priorRefund(list(data, has_more), PI, INV, "usd");
const throws = (run: () => unknown): string => {
  try {
    run();
    return "returned";
  } catch (error) {
    return error instanceof Error ? error.message : "threw";
  }
};

const DAY = Date.UTC(2026, 10, 6);
const SEC = DAY / 1000;
const SUB = "sub_MutOrderClosing01";
let invoiceIntent: unknown = PI;
let paymentRows: unknown[] = [];
let posts = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  if (path === "/v1/balance") return Response.json({ object: "balance", available: [{ amount: 100000, currency: "usd" }] });
  if (path === `/v1/invoices/${INV}`) return Response.json({ id: INV, payment_intent: invoiceIntent });
  if (path === "/v1/invoice_payments") return Response.json({ object: "list", has_more: false, data: paymentRows });
  if (path === `/v1/payment_intents/${PI}`) return Response.json({ id: PI, latest_charge: { id: "ch_MutClosing01", amount: 1000, currency: "usd", amount_refunded: 0, disputed: false, balance_transaction: null } });
  if (path === "/v1/refunds" && init?.method === "POST") {
    posts++;
    const body = new URLSearchParams(String(init.body));
    return Response.json({ object: "refund", id: "re_MutClosing02", amount: Number(body.get("amount")), currency: "usd", payment_intent: PI, status: "succeeded" });
  }
  if (path === "/v1/refunds") return Response.json({ object: "list", data: [], has_more: false });
  throw Error(`unexpected synthetic request ${path}`);
}) as typeof fetch;

async function seed(label: string, periods: [string, number][]) {
  redis.clear();
  posts = 0;
  const email = `mut-${label}@example.com`;
  await claimHandle(email, `mutcl${label}`, "Mutants", "");
  const store = { ...(await storeForEmail(email))!, stripeAccountId: "acct_MutClosing01" } as Store;
  const folder = await storeFolder(email);
  await redis.pipeline([
    ...periods.map(([sub, end]) => ["HSET", paidKey(folder), sub, JSON.stringify({ inv: INV, amt: 1000, tot: 1000, cur: "usd", ps: SEC - 15 * 86400, pe: end, e: "member@example.com" })]),
    ["HSET", workKey(folder), "calls", 30, "rcalls", 30],
  ]);
  return store;
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_closing_refunds_mutants";

  part("A refund already made for this invoice");
  is("a refund with no metadata, for something else, is passed over", prior([refund({ metadata: null })]), null);
  is("a refund with no closing mark is passed over", prior([refund({ metadata: {} })]), null);
  is("a mark that is not text: unknown", prior([refund({ metadata: { closing_refund: 5 } })]), "unknown");
  is("another invoice's closing refund is not this one's", prior([refund({ metadata: { closing_refund: "in_MutOther0001" } })]), null);
  is("this invoice's: done", prior([refund()]), { state: "done", amount: 500 });
  is("a failed one is passed over", prior([refund({ status: "failed" })]), null);
  is("an amount of zero: unknown", prior([refund({ amount: 0 })]), "unknown");
  is("a negative amount: unknown", prior([refund({ amount: -5 })]), "unknown");
  is("a list that says more follow: unknown", prior([refund()], true), "unknown");

  part("A refund's own state");
  is("no refund: unknown", refundState(null, PI, 500, "usd"), "unknown");
  is("an object that is not a refund: unknown", refundState(refund({ object: "charge" }), PI, 500, "usd"), "unknown");
  is("a refund: done", refundState(refund(), PI, 500, "USD"), "done");

  part("What the refund costs in the account's currency");
  is("rounded up, never down", settledCost(100, { amount: 1000, currency: "usd", balance_transaction: { amount: 333, currency: "eur" } }), { cur: "eur", amount: 34 });
  is("a charge of zero cannot be read", throws(() => settledCost(100, { amount: 0, currency: "usd", balance_transaction: null })), "what this payment's charge took could not be read");
  is("a negative charge cannot be read", throws(() => settledCost(100, { amount: -5, currency: "usd", balance_transaction: null })), "what this payment's charge took could not be read");
  is("a charge written as text cannot be read", throws(() => settledCost(100, { amount: "1000", currency: "usd", balance_transaction: null })), "what this payment's charge took could not be read");
  is("no settlement said", throws(() => settledCost(100, { amount: 1000, currency: "usd" })), "this payment's charge did not say what it settled as");
  is("a currency in capitals", throws(() => settledCost(100, { amount: 1000, currency: "USD", balance_transaction: null })), "this payment's charge currency could not be read");
  is("a currency in a list", throws(() => settledCost(100, { amount: 1000, currency: ["usd"], balance_transaction: null })), "this payment's charge currency could not be read");

  part("The members owed, latest period first");
  const order = await seed("order", [["sub_MutOrderB", SEC + 10 * 86400], ["sub_MutOrderA", SEC + 10 * 86400], ["sub_MutOrderC", SEC + 20 * 86400]]);
  is("by period end, then by subscription", (await unusedSummary(order, DAY)).rows.map((r) => r.sub), ["sub_MutOrderC", "sub_MutOrderA", "sub_MutOrderB"]);

  part("The payment refunded is the invoice's own");
  const paid = (intent: unknown) => ({ id: `inpay_${String(intent).slice(3)}`, invoice: INV, status: "paid", payment: { type: "payment_intent", payment_intent: intent } });
  invoiceIntent = "pi_bad";
  paymentRows = [paid(PI)];
  const odd = await giveBackUnused(await seed("odd", [[SUB, SEC + 15 * 86400]]), DAY, { final: true });
  is("an intent on the invoice that does not read sends to the listed payment", typeof odd === "object" ? [odd.done.map((x) => x.sub), posts] : odd, [[SUB], 1]);
  invoiceIntent = null;
  paymentRows = [paid("pi_bad"), paid(PI)];
  const second = await giveBackUnused(await seed("second", [[SUB, SEC + 15 * 86400]]), DAY, { final: true });
  is("a listed payment that reads after one that does not", typeof second === "object" ? [second.done.map((x) => x.sub), posts] : second, [[SUB], 1]);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
