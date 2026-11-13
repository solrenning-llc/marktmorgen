/**
 * #4451 (Codex X8, HIGH, money, store closing): a $100 invoice was paid $10 by charge A ($80, shared with another
 * invoice) and $90 by charge B. $50 of unused time is owed. Each charge is asked no more than what it paid toward
 * this invoice (invoice_payment.amount_paid) less what was already given back of it under this invoice, so A gives
 * $10 and B $40, never $40 of A that paid the other invoice. A paid payment whose share of this invoice does not
 * read keeps the debt for the next run: nothing is sent. Built on #4428 (#4411), whose stand-ins it reuses.
 */
import { giveBackUnused, unusedRows } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const ACCOUNT = "acct_closeshare1";
const SUB = "sub_closetwo1";
const INVOICE = "in_closetwo1";
const A = "pi_closetwoa1";
const B = "pi_closetwob1";
const CALLS = 40;

/** Each payment's charge: what it took and what was given back on it (all refunds). */
const charges = new Map<string, { amount: number; refunded: number }>();
/** Refunds made, as Stripe lists them for a payment. */
const made: { id: string; pi: string; amount: number; inv: string }[] = [];
/** What each payment paid toward this invoice (invoice_payment.amount_paid); a payment absent here has none that reads. */
const shares = new Map<string, unknown>();
let posts: { pi: string; amount: number; ok: boolean; key: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  if (path === `/invoices/${INVOICE}`) return Response.json({ id: INVOICE, object: "invoice", payment_intent: null });
  if (path === "/invoice_payments") {
    const rows = [A, B].map((pi, i) => ({ id: `inpay_closeshare${i}`, object: "invoice_payment", invoice: INVOICE, status: "paid", ...(shares.has(pi) ? { amount_paid: shares.get(pi) } : {}), payment: { type: "payment_intent", payment_intent: pi } }));
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
  const email = `closeshare-${label}@example.com`;
  await claimHandle(email, `closeshare${label}`, "Two charges fixture", "");
  const shop = { ...(await storeForEmail(email))!, stripeAccountId: ACCOUNT } as Store;
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: INVOICE, amt: 10000, tot: 10000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", CALLS],
  ]);
  return { shop, folder };
}

const saved = async (folder: string) => JSON.parse(String((await redis.pipeline([["HGET", paidKey(folder), SUB]]))[0])) as { r?: string; back?: number };

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_closing_share_synthetic";

  part("A pays $10 of this invoice out of $80, B $90: the $50 is split A $10 + B $40");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 8000, refunded: 0 });
  charges.set(B, { amount: 9000, refunded: 0 });
  shares.set(A, 1000);
  shares.set(B, 9000);
  const one = await seller("one");
  await giveBackUnused(one.shop, DAY);
  is("each charge is asked no more than its share of this invoice", posts.map((p) => [p.pi, p.amount]), [[A, 1000], [B, 4000]]);
  is("the member is settled done with $50 back", [(await saved(one.folder)).r, (await saved(one.folder)).back], ["done", 5000]);

  part("A payment's share of this invoice does not read: the debt is kept, nothing sent");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 8000, refunded: 0 });
  charges.set(B, { amount: 9000, refunded: 0 });
  shares.clear();
  shares.set(A, "1000");
  shares.set(B, 9000);
  const two = await seller("two");
  await giveBackUnused(two.shop, DAY);
  is("no refund is POSTed", posts, []);
  is("the member is not settled and is still listed", [(await saved(two.folder)).r ?? null, (await unusedRows(two.shop, DAY)).length], [null, 1]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
