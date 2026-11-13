/**
 * #4411 (Codex X8, HIGH, money, store closing): a member whose invoice was paid in two charges ($40 and $60) is
 * owed $50 of unused time. The refund is spread over the invoice's own paid charges, each within what it can
 * still give back, never asked whole of the first charge alone (which Stripe refuses, forever, run after run).
 * A run after a cut-short one counts what was already given under this invoice and never gives it twice.
 *
 * Synthetic only: Stripe is a stand-in fetch that refuses a refund above a charge's refundable balance, as
 * Stripe does (charge_exceeds_refundable); Redis is tests/redis-stub.ts.
 */
import { giveBackUnused, unusedRows } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const ACCOUNT = "acct_closetwo1";
const SUB = "sub_closetwo1";
const INVOICE = "in_closetwo1";
const A = "pi_closetwoa1";
const B = "pi_closetwob1";
const CALLS = 40;

/** Each payment's charge: what it took and what was given back on it (all refunds). */
const charges = new Map<string, { amount: number; refunded: number }>();
/** Refunds made, as Stripe lists them for a payment. */
const made: { id: string; pi: string; amount: number; inv: string }[] = [];
/** A third paid row of the invoice that does not read as a payment intent (a charge-type payment). */
let unreadRow = false;
let posts: { pi: string; amount: number; ok: boolean; key: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  if (path === `/invoices/${INVOICE}`) return Response.json({ id: INVOICE, object: "invoice", payment_intent: null });
  if (path === "/invoice_payments") {
    const rows = (unreadRow ? [A] : [A, B]).map((pi, i) => ({ id: `inpay_closetwo${i}`, object: "invoice_payment", invoice: INVOICE, status: "paid", amount_paid: charges.get(pi)?.amount ?? 0, payment: { type: "payment_intent", payment_intent: pi } }));
    // What each payment paid toward this invoice, as Stripe lists it (#4451): here, the whole of each charge.
    if (unreadRow) rows.push({ id: "inpay_closetwox", object: "invoice_payment", invoice: INVOICE, status: "paid", amount_paid: 6000, payment: { type: "charge", charge: "ch_closetwox" } as never });
    return Response.json({ object: "list", has_more: false, data: rows });
  }
  if (path.startsWith("/payment_intents/")) {
    const id = decodeURIComponent(path.slice("/payment_intents/".length));
    const c = charges.get(id);
    if (!c) return Response.json({ error: { message: "no such payment" } }, { status: 404 });
    return Response.json({ id, object: "payment_intent", latest_charge: { id: `ch_${id}`, payment_intent: id, amount: c.amount, currency: "usd", amount_refunded: c.refunded, disputed: false, balance_transaction: null } });
  }
  if (path === "/refunds" && init?.method === "POST") {
    const body = new URLSearchParams(String(init.body));
    const pi = String(body.get("payment_intent"));
    const amount = Number(body.get("amount"));
    const key = new Headers(init.headers).get("idempotency-key") ?? "";
    const c = charges.get(pi)!;
    if (amount > c.amount - c.refunded) {
      posts.push({ pi, amount, ok: false, key });
      return Response.json({ error: { type: "invalid_request_error", code: "charge_exceeds_refundable", message: "Refund amount is greater than unrefunded amount on charge" } }, { status: 400 });
    }
    posts.push({ pi, amount, ok: true, key });
    c.refunded += amount;
    const id = `re_closetwo${made.length + 1}`;
    made.push({ id, pi, amount, inv: String(body.get("metadata[closing_refund]")) });
    return Response.json({ id, object: "refund", amount, currency: "usd", payment_intent: pi, status: "succeeded", metadata: { closing_refund: body.get("metadata[closing_refund]") } });
  }
  if (path === "/refunds") {
    const pi = url.searchParams.get("payment_intent");
    return Response.json({ object: "list", has_more: false, data: made.filter((r) => r.pi === pi).map((r) => ({ id: r.id, object: "refund", amount: r.amount, currency: "usd", payment_intent: r.pi, status: "succeeded", metadata: { closing_refund: r.inv } })) });
  }
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

async function seller(label: string): Promise<{ shop: Store; folder: string }> {
  const email = `closetwo-${label}@example.com`;
  await claimHandle(email, `closetwo${label}`, "Two charges fixture", "");
  const shop = { ...(await storeForEmail(email))!, stripeAccountId: ACCOUNT } as Store;
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: INVOICE, amt: 10000, tot: 10000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", CALLS],
  ]);
  return { shop, folder };
}

const saved = async (folder: string) => JSON.parse(String((await redis.pipeline([["HGET", paidKey(folder), SUB]]))[0])) as { r?: string; back?: number };
const usedCalls = async (folder: string) => CALLS - Number((await redis.pipeline([["HGET", workKey(folder), "calls"]]))[0]);

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_closing_split_invoice_synthetic";

  part("A $100 invoice paid as $40 + $60, $50 unused: spread over both charges");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 4000, refunded: 0 });
  charges.set(B, { amount: 6000, refunded: 0 });
  const one = await seller("one");
  const out = await giveBackUnused(one.shop, DAY);
  const result = typeof out === "object" ? out : null;
  is("nothing failed", result?.failed, 0);
  is("$50 was given back in total", result?.done.reduce((sum, row) => sum + row.amount, 0), 5000);
  is("every refund asked was accepted by the provider", posts.length > 0 && posts.every((p) => p.ok), true);
  is("no charge gave back more than it took", [...charges.values()].every((c) => c.refunded <= c.amount), true);
  is("the member is settled done with $50 back", [(await saved(one.folder)).r, (await saved(one.folder)).back], ["done", 5000]);
  is("each refund has its own idempotency key", new Set(posts.map((p) => p.key)).size, posts.length);
  is("only the calls made are taken from the budget", await usedCalls(one.folder), 2 + 2 * 2 + posts.length);
  is("no longer listed", (await unusedRows(one.shop, DAY)).length, 0);

  part("A run cut short after the first charge's refund: the next run gives only the rest");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 4000, refunded: 4000 });
  charges.set(B, { amount: 6000, refunded: 0 });
  made.push({ id: "re_closetwoold1", pi: A, amount: 4000, inv: INVOICE });
  const two = await seller("two");
  const again = await giveBackUnused(two.shop, DAY);
  const second = typeof again === "object" ? again : null;
  is("nothing failed", second?.failed, 0);
  is("nothing more is asked of the first charge", posts.filter((p) => p.pi === A), []);
  is("$10 is asked of the second charge, accepted", posts.map((p) => [p.pi, p.amount, p.ok]), [[B, 1000, true]]);
  is("the member is settled done with $50 back in all", [(await saved(two.folder)).r, (await saved(two.folder)).back], ["done", 5000]);

  part("Both charges already gave back the whole $50 under this invoice: nothing is sent");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 4000, refunded: 4000 });
  charges.set(B, { amount: 6000, refunded: 1000 });
  made.push({ id: "re_closetwoold1", pi: A, amount: 4000, inv: INVOICE }, { id: "re_closetwoold2", pi: B, amount: 1000, inv: INVOICE });
  const three = await seller("three");
  await giveBackUnused(three.shop, DAY);
  is("no refund is POSTed", posts, []);
  is("settled done with $50 back", [(await saved(three.folder)).r, (await saved(three.folder)).back], ["done", 5000]);
  part("A paid row that does not read, and the readable charge cannot give back all that is owed: tried again, never settled short");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  unreadRow = true;
  charges.set(A, { amount: 4000, refunded: 0 });
  const four = await seller("four");
  const partial = await giveBackUnused(four.shop, DAY);
  const fourth = typeof partial === "object" ? partial : null;
  is("what the readable charge can give is given, accepted", posts.map((p) => [p.pi, p.amount, p.ok]), [[A, 4000, true]]);
  is("counted failed, not done", [fourth?.failed, fourth?.done.length], [1, 0]);
  is("the member is not settled and is still listed", [(await saved(four.folder)).r ?? null, (await unusedRows(four.shop, DAY)).length], [null, 1]);
  posts = [];
  await giveBackUnused(four.shop, DAY);
  is("the next run never asks that charge again", posts.filter((p) => p.pi === A), []);
  unreadRow = false;
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
