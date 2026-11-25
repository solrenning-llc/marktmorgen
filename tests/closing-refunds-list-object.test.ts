/**
 * Codex X8-20261120-0318 (MEDIUM, money; row 45 of the Codex findings board #5010): the closing refunds read two
 * Stripe lists without checking that the reply is a list (`object: "list"`). A reply that only looks like one, with
 * `data: []` and `has_more: false` but no `object`, was taken for a whole, empty list:
 * - the invoice's payments (`intentsOf`): an invoice that names no payment was settled as "none paid", for good,
 *   and the member was never given anything back;
 * - a disputed charge's disputes (`disputedAway`, read for an invoice paid in more than one charge): no dispute was
 *   counted, so the amount a lost dispute had already given the buyer was given back again on the other charge.
 * Each now reads only a reply that is a Stripe list; anything else fails the member, who is tried again.
 *
 * Synthetic only: an in-memory Redis and a fetch that answers Stripe; no real account, refund or email.
 */
import { giveBackUnused } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const SEC = DAY / 1000;
const SUB = "sub_X8ListObject01";
const INV = "in_X8ListObject01";
const PI = "pi_X8ListObject01";
const CH = "ch_X8ListObject01";
// The second payment of an invoice paid in two parts, the case where a dispute's amount is read (disputedAway).
const PI2 = "pi_X8ListObject02";
const CH2 = "ch_X8ListObject02";

// What each list answers: a Stripe list, or the same fields without `object: "list"`.
let paymentsListed = true;
let paymentRows: unknown[] = [];
let invoiceNames: string | null = null;
let disputed = false;
let disputesListed = true;
let posts = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
  if (path === "/v1/balance") return Response.json({ object: "balance", available: [{ amount: 100000, currency: "usd" }] });
  if (path === `/v1/invoices/${INV}`) return Response.json({ id: INV, payment_intent: invoiceNames });
  if (path === "/v1/invoice_payments") return Response.json({ ...(paymentsListed ? { object: "list" } : {}), has_more: false, data: paymentRows });
  if (path === `/v1/payment_intents/${PI}`) {
    const amount = paymentRows.length > 1 ? 500 : 1000;
    return Response.json({ id: PI, latest_charge: { id: CH, amount, currency: "usd", amount_refunded: 0, disputed, balance_transaction: null } });
  }
  if (path === `/v1/payment_intents/${PI2}`) {
    return Response.json({ id: PI2, latest_charge: { id: CH2, amount: 500, currency: "usd", amount_refunded: 0, disputed: false, balance_transaction: null } });
  }
  // The first charge's dispute, lost: the bank gave its 500 back to the buyer.
  if (path === "/v1/disputes") {
    return Response.json({ ...(disputesListed ? { object: "list" } : {}), has_more: false, data: disputesListed ? [{ id: "dp_X8ListObject01", object: "dispute", charge: CH, status: "lost", amount: 500, currency: "usd" }] : [] });
  }
  if (path === "/v1/refunds" && init?.method === "POST") {
    posts += 1;
    const body = new URLSearchParams(String(init.body));
    return Response.json({ object: "refund", id: `re_X8ListObject${posts}`, amount: Number(body.get("amount")), currency: "usd", payment_intent: body.get("payment_intent"), status: "succeeded" });
  }
  if (path === "/v1/refunds") return Response.json({ object: "list", data: [], has_more: false });
  throw new Error(`unexpected synthetic request ${path}`);
}) as typeof fetch;

const paidRow = { id: "inpay_X8ListObject", invoice: INV, status: "paid", payment: { type: "payment_intent", payment_intent: PI } };
const paidRow2 = { id: "inpay_X8ListObject2", invoice: INV, status: "paid", payment: { type: "payment_intent", payment_intent: PI2 } };

async function seed(label: string): Promise<{ store: Store }> {
  redis.clear();
  posts = 0;
  const email = `x8-${label}@example.com`;
  await claimHandle(email, `x8list${label}`, "X8 list", "");
  const store = { ...(await storeForEmail(email))!, stripeAccountId: "acct_X8ListObject01" } as Store;
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: INV, amt: 1000, tot: 1000, cur: "usd", ps: SEC - 15 * 86400, pe: SEC + 15 * 86400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 30, "rcalls", 30],
  ]);
  return { store };
}

const outcome = (result: Awaited<ReturnType<typeof giveBackUnused>>) =>
  typeof result === "object" ? [result.failed, result.none, result.disputed, result.done.length, posts] : result;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_x8_list_object";

  part("An invoice's payments: only a Stripe list may say that none was paid");
  invoiceNames = null;
  disputed = false;
  paymentRows = [];
  paymentsListed = true;
  const listedNone = await seed("listed-none");
  is("control: a whole, empty list settles none", outcome(await giveBackUnused(listedNone.store, DAY, { final: true })), [0, 1, 0, 0, 0]);
  paymentsListed = false;
  const unlisted = await seed("unlisted-none");
  is("the same fields without object 'list': the member fails, never settled as none", outcome(await giveBackUnused(unlisted.store, DAY, { final: true })), [1, 0, 0, 0, 0]);

  part("A disputed charge's disputes: only a Stripe list may say that none took anything");
  // An invoice of 1,000 paid in two charges of 500; the first one disputed and lost.
  paymentsListed = true;
  paymentRows = [paidRow, paidRow2];
  disputed = true;
  disputesListed = true;
  const listedDisputes = await seed("listed-disputes");
  // The lost dispute already gave the buyer 500, as much as the unused half of the period: nothing more is given back,
  // and the member is settled "disputed".
  is("control: the lost dispute read whole, nothing more is given back", outcome(await giveBackUnused(listedDisputes.store, DAY, { final: true })), [0, 0, 1, 0, 0]);
  disputesListed = false;
  const unlistedDisputes = await seed("unlisted-disputes");
  is("the same fields without object 'list': the member fails, and the dispute's 500 is not given back a second time", outcome(await giveBackUnused(unlistedDisputes.store, DAY, { final: true })), [1, 0, 0, 0, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
