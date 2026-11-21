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
/** The second payment (B) listed with this status instead of "paid", when set: one not paid yet. */
let secondStatus: string | null = null;
let posts: { pi: string; amount: number; ok: boolean; key: string }[] = [];
/** Once, before a refund POST is taken: the creator refunds that whole charge elsewhere first (Codex P on #4428). */
let refundedElsewhereFirst: string | null = null;
/** The invoice's own payment_intent field (null in newer API versions). */
let direct: string | null = null;
/** Once, when a refund POST to `on` is accepted: the creator refunds `amount` of `charge` elsewhere (Codex G on #4428). */
let elsewhereOnPost: { on: string; charge: string; amount: number } | null = null;
/** A charge's disputes, by payment: each with its amount and status (the charge reads disputed while it has one). */
const disputes = new Map<string, { amount: number; status: string }[]>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  if (path === `/invoices/${INVOICE}`) return Response.json({ id: INVOICE, object: "invoice", payment_intent: direct });
  if (path === "/invoice_payments") {
    const rows = (unreadRow ? [A] : [A, B]).map((pi, i) => ({ id: `inpay_closetwo${i}`, object: "invoice_payment", invoice: INVOICE, status: pi === B && secondStatus ? secondStatus : "paid", payment: { type: "payment_intent", payment_intent: pi } }));
    if (unreadRow) rows.push({ id: "inpay_closetwox", object: "invoice_payment", invoice: INVOICE, status: "paid", payment: { type: "charge", charge: "ch_closetwox" } as never });
    return Response.json({ object: "list", has_more: false, data: rows });
  }
  if (path.startsWith("/payment_intents/")) {
    const id = decodeURIComponent(path.slice("/payment_intents/".length));
    const c = charges.get(id);
    if (!c) return Response.json({ error: { message: "no such payment" } }, { status: 404 });
    return Response.json({ id, object: "payment_intent", latest_charge: { id: `ch_${id.slice(3)}`, payment_intent: id, amount: c.amount, currency: "usd", amount_refunded: c.refunded, disputed: disputes.has(id), balance_transaction: null } });
  }
  if (path === "/disputes") {
    const charge = String(url.searchParams.get("charge"));
    const pi = `pi_${charge.slice(3)}`;
    const rows = (disputes.get(pi) ?? []).map((d, i) => ({ id: `dp_closetwo${i}`, object: "dispute", charge, payment_intent: pi, amount: d.amount, currency: "usd", status: d.status, balance_transactions: [] }));
    return Response.json({ object: "list", has_more: false, data: rows });
  }
  if (path === "/refunds" && init?.method === "POST") {
    const body = new URLSearchParams(String(init.body));
    const pi = String(body.get("payment_intent"));
    const amount = Number(body.get("amount"));
    const key = new Headers(init.headers).get("idempotency-key") ?? "";
    const c = charges.get(pi)!;
    if (refundedElsewhereFirst === pi) {
      refundedElsewhereFirst = null;
      c.refunded = c.amount;
      posts.push({ pi, amount, ok: false, key });
      return Response.json({ error: { type: "invalid_request_error", code: "charge_already_refunded", message: "Charge has already been refunded." } }, { status: 400 });
    }
    if (amount > c.amount - c.refunded) {
      posts.push({ pi, amount, ok: false, key });
      return Response.json({ error: { type: "invalid_request_error", code: "charge_exceeds_refundable", message: "Refund amount is greater than unrefunded amount on charge" } }, { status: 400 });
    }
    if (disputes.has(pi)) {
      posts.push({ pi, amount, ok: false, key });
      return Response.json({ error: { type: "invalid_request_error", code: "charge_disputed", message: "Charge is disputed." } }, { status: 400 });
    }
    posts.push({ pi, amount, ok: true, key });
    c.refunded += amount;
    if (elsewhereOnPost?.on === pi) {
      charges.get(elsewhereOnPost.charge)!.refunded += elsewhereOnPost.amount;
      elsewhereOnPost = null;
    }
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

async function seller(label: string, pi?: string): Promise<{ shop: Store; folder: string }> {
  const email = `closetwo-${label}@example.com`;
  await claimHandle(email, `closetwo${label}`, "Two charges fixture", "");
  const shop = { ...(await storeForEmail(email))!, stripeAccountId: ACCOUNT } as Store;
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: INVOICE, ...(pi ? { pi } : {}), amt: 10000, tot: 10000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", CALLS],
  ]);
  return { shop, folder };
}

const saved = async (folder: string) => JSON.parse(String((await redis.pipeline([["HGET", paidKey(folder), SUB]]))[0])) as { r?: string; back?: number; want?: number };
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
  // The invoice and its list, then every charge and its refunds read again before each refund (Codex G on #4428).
  is("only the calls made are taken from the budget", await usedCalls(one.folder), 2 + posts.length * 2 * 2 + posts.length);
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
  part("A paid row that does not read beside a readable charge: nothing is given back, tried again, never settled short (Codex L on #4428)");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  unreadRow = true;
  charges.set(A, { amount: 4000, refunded: 0 });
  const four = await seller("four");
  const partial = await giveBackUnused(four.shop, DAY);
  const fourth = typeof partial === "object" ? partial : null;
  is("nothing is given back while a paid row does not read", posts, []);
  is("counted failed, not done", [fourth?.failed, fourth?.done.length], [1, 0]);
  is("the member is not settled and is still listed", [(await saved(four.folder)).r ?? null, (await unusedRows(four.shop, DAY)).length], [null, 1]);
  posts = [];
  await giveBackUnused(four.shop, DAY);
  is("nor on the next run, while it still does not read", posts, []);
  unreadRow = false;

  part("The first charge is refunded whole elsewhere between the read and the POST (Codex P on #4428): nothing goes through the second on the old figures");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 4000, refunded: 0 });
  charges.set(B, { amount: 6000, refunded: 0 });
  refundedElsewhereFirst = A;
  const five = await seller("five");
  const raced = await giveBackUnused(five.shop, DAY);
  const fifth = typeof raced === "object" ? raced : null;
  is("nothing is asked of the second charge on the figures read before", posts.filter((p) => p.pi === B), []);
  is("counted failed, the member not settled", [fifth?.failed, (await saved(five.folder)).r ?? null], [1, null]);
  posts = [];
  await giveBackUnused(five.shop, DAY);
  is("the next run reads again and gives only the rest: $10 through the second", posts.map((p) => [p.pi, p.amount, p.ok]), [[B, 1000, true]]);
  is("$50 back in all, never $90", [...charges.values()].reduce((sum, c) => sum + c.refunded, 0), 5000);

  part("The second payment in a status this code does not know (processing) beside a paid one: nothing is given back until it reads (Codex P on #4428)");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 10000, refunded: 0 });
  charges.set(B, { amount: 6000, refunded: 0 });
  secondStatus = "processing";
  const six = await seller("six");
  const waiting = await giveBackUnused(six.shop, DAY);
  const sixth = typeof waiting === "object" ? waiting : null;
  is("nothing is given back, even though the paid charge could cover it all", posts, []);
  is("counted failed, the member not settled", [sixth?.failed, (await saved(six.folder)).r ?? null], [1, null]);
  secondStatus = null;
  charges.set(A, { amount: 4000, refunded: 0 });
  posts = [];
  await giveBackUnused(six.shop, DAY);
  is("once it reads as paid, the next run gives over both: $40 and $10", posts.map((p) => [p.pi, p.amount, p.ok]), [[A, 4000, true], [B, 1000, true]]);
  is("settled done with $50 back", [(await saved(six.folder)).r, (await saved(six.folder)).back], ["done", 5000]);

  part("A partial refund made elsewhere on the second charge while the first is refunded (Codex G on #4428): nothing more on the old figures");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 4000, refunded: 0 });
  charges.set(B, { amount: 6000, refunded: 0 });
  elsewhereOnPost = { on: A, charge: B, amount: 1000 };
  const seven = await seller("seven");
  await giveBackUnused(seven.shop, DAY);
  is("only the first charge is refunded: the second already gave the rest elsewhere", posts.map((p) => [p.pi, p.amount, p.ok]), [[A, 4000, true]]);
  is("$50 back in all, never $60", [...charges.values()].reduce((sum, c) => sum + c.refunded, 0), 5000);
  is("settled done with what this closing gave back", [(await saved(seven.folder)).r, (await saved(seven.folder)).back], ["done", 4000]);

  part("A held period that kept the first charge's payment as its only one, before #4428 (Codex X5): every charge is still read");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 4000, refunded: 0 });
  charges.set(B, { amount: 6000, refunded: 0 });
  const eight = await seller("eight", A);
  await giveBackUnused(eight.shop, DAY);
  is("given over both charges: $40 and $10", posts.map((p) => [p.pi, p.amount, p.ok]), [[A, 4000, true], [B, 1000, true]]);
  is("settled done with $50 back", [(await saved(eight.folder)).r, (await saved(eight.folder)).back], ["done", 5000]);

  part("The invoice still names its first payment as its payment_intent, and lists both (Codex P on #4428): given over both");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 4000, refunded: 0 });
  charges.set(B, { amount: 6000, refunded: 0 });
  direct = A;
  const nine = await seller("nine");
  await giveBackUnused(nine.shop, DAY);
  is("given over both charges: $40 and $10, never $50 asked of the first", posts.map((p) => [p.pi, p.amount, p.ok]), [[A, 4000, true], [B, 1000, true]]);
  is("settled done with $50 back", [(await saved(nine.folder)).r, (await saved(nine.folder)).back], ["done", 5000]);
  direct = null;

  part("The first charge lost a $40 dispute (Codex U and N1 on #4428): the dispute's money counts, and the rest goes back through the second");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 4000, refunded: 0 });
  charges.set(B, { amount: 6000, refunded: 0 });
  disputes.set(A, [{ amount: 4000, status: "lost" }]);
  const ten = await seller("ten");
  const disputed = await giveBackUnused(ten.shop, DAY);
  const tenth = typeof disputed === "object" ? disputed : null;
  is("nothing is asked of the disputed charge; $10 goes back through the second", posts.map((p) => [p.pi, p.amount, p.ok]), [[B, 1000, true]]);
  is("settled done with the $10 this closing gave back, never left owed", [tenth?.failed, (await saved(ten.folder)).r, (await saved(ten.folder)).back], [0, "done", 1000]);

  part("The first charge's dispute was won by the creator: it gave the buyer nothing, so the second gives back all $50");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 4000, refunded: 0 });
  charges.set(B, { amount: 6000, refunded: 0 });
  disputes.set(A, [{ amount: 4000, status: "won" }]);
  const eleven = await seller("eleven");
  await giveBackUnused(eleven.shop, DAY);
  is("$50 goes back through the second charge", posts.map((p) => [p.pi, p.amount, p.ok]), [[B, 5000, true]]);
  is("settled done with $50 back", [(await saved(eleven.folder)).r, (await saved(eleven.folder)).back], ["done", 5000]);

  part("A partial dispute and the other charge cannot cover all unused time");
  redis.clear();
  charges.clear();
  disputes.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 6000, refunded: 0 });
  charges.set(B, { amount: 4000, refunded: 0 });
  disputes.set(A, [{ amount: 500, status: "lost" }]);
  const residual = await seller("residual");
  const beforeClosing = await giveBackUnused(residual.shop, DAY);
  is("$40 goes back through the available charge", posts.map(({ pi, amount }) => [pi, amount]), [[B, 4000]]);
  is("the outstanding $5 keeps the member eligible for reconciliation",
    [typeof beforeClosing === "object" && beforeClosing.done.length, (await unusedRows(residual.shop, DAY)).length], [0, 1]);
  const closing = await giveBackUnused(residual.shop, DAY, { final: true });
  is("the closing-day notice reports exactly the unpaid $5",
    typeof closing === "object" && closing.unmade.map(({ sub, amount, cur }) => [sub, amount, cur]), [[SUB, 500, "usd"]]);
  const savedResidual = await saved(residual.folder);
  is("the closing-day remainder is saved for notice without repeating the $40 refund",
    [savedResidual.r, savedResidual.want, posts.length, charges.get(B)?.refunded], ["over", 500, 1, 4000]);

  part("A dispute whose status does not read: nothing is given back, tried again, never settled");
  redis.clear();
  charges.clear();
  made.length = 0;
  posts = [];
  charges.set(A, { amount: 4000, refunded: 0 });
  charges.set(B, { amount: 6000, refunded: 0 });
  disputes.set(A, [{ amount: 4000, status: "future_status" }]);
  const twelve = await seller("twelve");
  const unknown = await giveBackUnused(twelve.shop, DAY);
  const twelfth = typeof unknown === "object" ? unknown : null;
  is("nothing is given back", posts, []);
  is("counted failed, the member not settled", [twelfth?.failed, (await saved(twelve.folder)).r ?? null], [1, null]);
  disputes.clear();
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
