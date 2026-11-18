/**
 * Claude 1's review of #4428 @5625a5c95a, MEDIUM, money, store closing: an invoice paid in two charges ($40 + $60),
 * $50 of unused time owed.
 *
 * 1. A refund on one charge that Stripe's list later confirms failed is tried again under a key of its own (Codex X8,
 *    #4480, applied to the split path): under the same key Stripe replays its first answer, so a member would be
 *    recorded given back (pending or done) with nothing given.
 * 2. On the closing day, a refund Stripe refuses records what is still owed from the figures just read (the
 *    creator's own refunds and what this pass already gave on the other charge taken off), never the unused part
 *    less only what earlier closings recorded.
 *
 * Synthetic only: Stripe is a stand-in fetch that, as Stripe does, answers a request sent again under a key it has
 * seen with the answer it stored for that key; Redis is tests/redis-stub.ts.
 */
import { giveBackUnused } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const ACCOUNT = "acct_splitkey1";
const SUB = "sub_splitkey1";
const INVOICE = "in_splitkey1";
const A = "pi_splitkeya1";
const B = "pi_splitkeyb1";

/** Each payment's charge: what it took and what succeeded in coming back on it. */
const charges = new Map<string, { amount: number; refunded: number }>();
/** Every refund Stripe holds, as its list shows them; a status can be changed later, as Stripe does. */
const refunds: { id: string; pi: string; amount: number; inv: string; status: string }[] = [];
/** Each idempotency key's stored answer, replayed whenever the key is sent again. */
const stored = new Map<string, Record<string, unknown>>();
/** The status each new refund POST (not a replay) is made with, in order; "succeeded" when the list is empty. */
let nextStatus: string[] = [];
let posts: { pi: string; amount: number; key: string; replay: boolean }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  if (path === `/invoices/${INVOICE}`) return Response.json({ id: INVOICE, object: "invoice", payment_intent: null });
  if (path === "/invoice_payments") {
    const rows = [A, B].map((pi, i) => ({ id: `inpay_splitkey${i}`, object: "invoice_payment", invoice: INVOICE, status: "paid", payment: { type: "payment_intent", payment_intent: pi } }));
    return Response.json({ object: "list", has_more: false, data: rows });
  }
  if (path.startsWith("/payment_intents/")) {
    const id = decodeURIComponent(path.slice("/payment_intents/".length));
    const c = charges.get(id);
    if (!c) return Response.json({ error: { message: "no such payment" } }, { status: 404 });
    return Response.json({ id, object: "payment_intent", latest_charge: { id: `ch_${id.slice(3)}`, payment_intent: id, amount: c.amount, currency: "usd", amount_refunded: c.refunded, disputed: false, balance_transaction: null } });
  }
  if (path === "/refunds" && init?.method === "POST") {
    const body = new URLSearchParams(String(init.body));
    const pi = String(body.get("payment_intent"));
    const amount = Number(body.get("amount"));
    const key = new Headers(init.headers).get("idempotency-key") ?? "";
    const known = stored.get(key);
    posts.push({ pi, amount, key, replay: Boolean(known) });
    if (known) return Response.json(known);
    const status = nextStatus.shift() ?? "succeeded";
    const id = `re_splitkey${refunds.length + 1}`;
    const inv = String(body.get("metadata[closing_refund]"));
    refunds.push({ id, pi, amount, inv, status });
    if (status === "succeeded" || status === "pending") charges.get(pi)!.refunded += amount;
    const answer = { id, object: "refund", amount, currency: "usd", payment_intent: pi, status, metadata: { closing_refund: inv } };
    stored.set(key, answer);
    return Response.json(answer);
  }
  if (path === "/refunds") {
    const pi = url.searchParams.get("payment_intent");
    const rows = refunds.filter((r) => r.pi === pi).map((r) => ({ id: r.id, object: "refund", amount: r.amount, currency: "usd", payment_intent: r.pi, status: r.status, metadata: r.inv ? { closing_refund: r.inv } : {} }));
    return Response.json({ object: "list", has_more: false, data: rows });
  }
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

async function seller(label: string): Promise<{ shop: Store; folder: string }> {
  redis.clear();
  charges.clear();
  refunds.length = 0;
  stored.clear();
  posts = [];
  charges.set(A, { amount: 4000, refunded: 0 });
  charges.set(B, { amount: 6000, refunded: 0 });
  const email = `splitkey-${label}@example.com`;
  await claimHandle(email, `splitkey${label}`, "Split key fixture", "");
  const shop = { ...(await storeForEmail(email))!, stripeAccountId: ACCOUNT } as Store;
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: INVOICE, amt: 10000, tot: 10000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 200, "rcalls", 200],
  ]);
  return { shop, folder };
}

const saved = async (folder: string) => JSON.parse(String((await redis.pipeline([["HGET", paidKey(folder), SUB]]))[0])) as { r?: string; back?: number; want?: number; f?: number };

async function pass(shop: Store, final = false) {
  const out = await giveBackUnused(shop, DAY, final ? { final: true } : {});
  if (typeof out === "string") throw new Error(`the pass did not settle: ${out}`);
  return out;
}

/** Stripe's list now shows the second charge's refund failed, and its money back on the charge. */
function failLater(pi: string) {
  for (const r of refunds) {
    if (r.pi !== pi || r.status === "failed") continue;
    r.status = "failed";
    charges.get(pi)!.refunded -= r.amount;
  }
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_closing_split_failed_key_synthetic";

  part("The second charge's refund answered pending, then listed failed: the next pass makes it under a new key");
  let one = await seller("pend");
  nextStatus = ["succeeded", "pending"];
  const first = await pass(one.shop);
  is("first pass: $40 then $10, pending", [posts.map((p) => [p.pi, p.amount]), first.pending], [[[A, 4000], [B, 1000]], 1]);
  failLater(B);
  posts = [];
  nextStatus = ["succeeded"];
  const second = await pass(one.shop);
  is("only the second charge is asked again, for $10", posts.map((p) => [p.pi, p.amount]), [[B, 1000]]);
  is("under a key of its own, never replayed", posts.map((p) => [p.key, p.replay]), [[`closing-refund:${INVOICE}:${B}:1`, false]]);
  is("a new refund was made on the second charge", refunds.filter((r) => r.pi === B).map((r) => r.status), ["failed", "succeeded"]);
  is("settled done with $50 back", [second.done.length, (await saved(one.folder)).r, (await saved(one.folder)).back], [1, "done", 5000]);
  is("$50 came back in all", [...charges.values()].reduce((sum, c) => sum + c.refunded, 0), 5000);

  part("The second charge's refund answered failed: the next pass tries again under a new key, never the failed answer replayed");
  one = await seller("fail");
  nextStatus = ["succeeded", "failed"];
  const refused = await pass(one.shop);
  is("first pass: counted failed, not settled", [refused.failed, (await saved(one.folder)).r ?? null], [1, null]);
  posts = [];
  nextStatus = ["succeeded"];
  const retried = await pass(one.shop);
  is("the second charge asked again, for $10, under a new key", posts.map((p) => [p.pi, p.amount, p.key, p.replay]), [[B, 1000, `closing-refund:${INVOICE}:${B}:1`, false]]);
  is("settled done with $50 back", [retried.done.length, (await saved(one.folder)).r, (await saved(one.folder)).back], [1, "done", 5000]);

  part("Each confirmed failure moves the second charge's key on once; the first charge keeps its key");
  one = await seller("two");
  nextStatus = ["succeeded", "failed"];
  await pass(one.shop);
  nextStatus = ["failed"];
  await pass(one.shop);
  posts = [];
  nextStatus = ["succeeded"];
  await pass(one.shop);
  is("the third key", posts.map((p) => [p.key, p.replay]), [[`closing-refund:${INVOICE}:${B}:2`, false]]);
  is("the first charge's refund made once", refunds.filter((r) => r.pi === A).length, 1);
  is("settled done with $50 back", [(await saved(one.folder)).r, (await saved(one.folder)).back], ["done", 5000]);

  part("Closing day: $40 given on the first charge in this pass, $10 refused on the second: $10 is still owed, never $50");
  one = await seller("final");
  nextStatus = ["succeeded", "failed"];
  const last = await pass(one.shop, true);
  is("told $10 was not made, never $50", last.unmade.map((u) => [u.amount, u.cur]), [[1000, "usd"]]);
  is("recorded final with $10 still owed", [(await saved(one.folder)).r, (await saved(one.folder)).want, (await saved(one.folder)).f], ["over", 1000, 1]);

  part("Closing day: the creator already gave $40 back on the first charge, $10 refused on the second: $10 still owed");
  one = await seller("creator");
  charges.get(A)!.refunded = 4000;
  refunds.push({ id: "re_splitkeycreator", pi: A, amount: 4000, inv: "", status: "succeeded" });
  nextStatus = ["failed"];
  const own = await pass(one.shop, true);
  is("only the second charge is asked, for $10", posts.map((p) => [p.pi, p.amount]), [[B, 1000]]);
  is("told $10 was not made, never $50", own.unmade.map((u) => u.amount), [1000]);
  is("recorded final with $10 still owed", [(await saved(one.folder)).r, (await saved(one.folder)).want], ["over", 1000]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
