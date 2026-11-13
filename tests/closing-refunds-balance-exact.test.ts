/**
 * CX-123 rule 24 (audit R24 round 6, finding 1): on the closing day (giveBackUnused with final: true) the creator's
 * Stripe balance and the charge's settlement cost are read in their exact shape. A GET /balance in another shape, a
 * row of it that does not read, or a balance transaction / charge currency that does not read is unknown: the member
 * is counted failed and tried again (lib/plan-closing.ts holds the closing while `failed > 0`), never recorded as a
 * final "short" (which sends the "the creator's balance did not cover it" letter) and never refunded on a guess.
 * A confirmed empty balance stays short, and the healthy paths still refund.
 */
import { giveBackUnused, unusedRows } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const SUB = "sub_r24balance";
const INTENT = "pi_r24balance";
const healthyCharge = { id: "ch_r24balance", amount: 1000, currency: "usd", amount_refunded: 0, disputed: false, balance_transaction: null };
let balance: unknown = null;
let charge: Record<string, unknown> = healthyCharge;
let posts = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json(balance);
  if (path === `/payment_intents/${INTENT}`) return Response.json({ id: INTENT, object: "payment_intent", latest_charge: charge });
  if (path === "/refunds" && init?.method === "POST") {
    posts += 1;
    const body = new URLSearchParams(String(init.body));
    return Response.json({ id: "re_r24balance", object: "refund", amount: Number(body.get("amount")), currency: "usd", payment_intent: INTENT, status: "succeeded" });
  }
  if (path === "/refunds") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

async function run(label: string, reply: unknown, chargeReply: Record<string, unknown> = healthyCharge) {
  redis.clear();
  posts = 0;
  balance = reply;
  charge = chargeReply;
  const email = `r24bal-${label}@example.com`;
  await claimHandle(email, `r24bal${label}`, "Balance fixture", "");
  const shop = (await storeForEmail(email))!;
  const seller: Store = { ...shop, stripeAccountId: "acct_r24bal" };
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: "in_r24balance", pi: INTENT, amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 20, "rcalls", 10],
  ]);
  const out = await giveBackUnused(seller, DAY, { final: true });
  const [raw] = await redis.pipeline([["HGET", paidKey(folder), SUB]]);
  const saved = JSON.parse(String(raw)) as { r?: string; f?: number };
  return { out, saved, posts, remaining: (await unusedRows(seller, DAY)).length };
}

/** What an unknown reply must give: tried again, nothing written, nothing sent, no short letter queued. */
async function refused(label: string, reply: unknown, chargeReply?: Record<string, unknown>) {
  const { out, saved, posts: sent, remaining } = await run(label, reply, chargeReply);
  is(
    `${label}: counted failed and tried again, never a final short, never refunded`,
    typeof out === "object" ? [out.failed, out.short.length, out.done.length, sent, saved.r ?? null, saved.f ?? null, remaining] : out,
    [1, 0, 0, 0, null, null, 1],
  );
}

const usd = (amount: unknown, currency: unknown = "usd") => ({ amount, currency, source_types: { card: amount } });

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_r24_balance_synthetic_only";

  part("GET /balance in another shape: unknown, never an empty balance");
  await refused("availtext", { object: "balance", available: "x", pending: [] });
  await refused("noavail", { object: "balance", pending: [] });
  await refused("noobject", { available: [usd(100_000)], pending: [] });
  await refused("otherobject", { object: "customer", available: [usd(100_000)], pending: [] });
  await refused("nullbody", null);
  await refused("listbody", [usd(100_000)]);

  part("A row of the balance that does not read: unknown, never dropped in silence");
  await refused("textamount", { available: [{ amount: "500", currency: "usd" }] });
  await refused("onebadrow", { object: "balance", available: [usd(100_000), usd("500")], pending: [] });
  await refused("fraction", { object: "balance", available: [usd(100_000.5)], pending: [] });
  await refused("unsafe", { object: "balance", available: [usd(2 ** 53)], pending: [] });
  await refused("nocurrency", { object: "balance", available: [{ amount: 100_000 }], pending: [] });
  await refused("upper", { object: "balance", available: [usd(100_000, "USD")], pending: [] });
  await refused("longcur", { object: "balance", available: [usd(100_000, "usdx")], pending: [] });
  await refused("nullrow", { object: "balance", available: [null], pending: [] });
  await refused("twice", { object: "balance", available: [usd(100), usd(100_000)], pending: [] });

  part("The charge's settlement cost that does not read: unknown, never weighed in another currency");
  const euros = { object: "balance", available: [usd(100_000, "eur")], pending: [] };
  await refused("bttextamount", euros, { ...healthyCharge, balance_transaction: { amount: "900", currency: "eur" } });
  await refused("btzero", euros, { ...healthyCharge, balance_transaction: { amount: 0, currency: "eur" } });
  await refused("btnocur", euros, { ...healthyCharge, balance_transaction: { amount: 900 } });
  await refused("btupper", euros, { ...healthyCharge, balance_transaction: { amount: 900, currency: "EUR" } });
  await refused("btid", euros, { ...healthyCharge, balance_transaction: "txn_r24balance" });
  const noTransaction: Record<string, unknown> = { ...healthyCharge };
  delete noTransaction.balance_transaction;
  await refused("btmissing", euros, noTransaction);
  await refused("chargecur", { object: "balance", available: [usd(100_000)], pending: [] }, { ...healthyCharge, currency: 840 });

  part("Controls: a confirmed empty balance is short; the healthy paths refund");
  {
    const { out, saved, posts: sent } = await run("empty", { object: "balance", available: [], pending: [] });
    is("a confirmed empty balance: final short, nothing sent", typeof out === "object" ? [out.short.length, out.failed, sent, saved.r, saved.f] : out, [1, 0, 0, "short", 1]);
  }
  {
    const { out, saved, posts: sent } = await run("low", { object: "balance", available: [usd(100)], pending: [] });
    is("a readable balance that does not cover it: final short, nothing sent", typeof out === "object" ? [out.short.length, out.failed, sent, saved.r, saved.f] : out, [1, 0, 0, "short", 1]);
  }
  {
    const { out, saved, posts: sent } = await run("healthy", { object: "balance", available: [usd(100_000)], pending: [usd(0)], livemode: false });
    is("a readable dollar balance that covers it: refunded once", typeof out === "object" ? [out.done.length, out.failed, sent, saved.r] : out, [1, 0, 1, "done"]);
  }
  {
    const { out, saved, posts: sent } = await run("euro", euros, { ...healthyCharge, balance_transaction: { amount: 900, currency: "eur" } });
    is("a readable euro balance weighed in the currency it settles in: refunded once", typeof out === "object" ? [out.done.length, out.failed, sent, saved.r] : out, [1, 0, 1, "done"]);
  }
  {
    const { out, saved } = await run("euroshort", { object: "balance", available: [usd(449, "eur")], pending: [] }, { ...healthyCharge, balance_transaction: { amount: 900, currency: "eur" } });
    is("a euro balance one cent short of the settled cost (450): final short", typeof out === "object" ? [out.short.length, out.failed, saved.r] : out, [1, 0, "short"]);
  }
  done();
}
void main();
