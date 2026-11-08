/**
 * Rules 24 and 30 (from #3097): a closing store gives its members their unused
 * time back (lib/closing-refunds.ts, giveBackUnused), reading the member's
 * invoice, its payments and its payment intent by id. A reply from Stripe that
 * is not the object asked for (another's, one with no id, or none at all), or
 * one whose charge does not read, decides nothing: no refund is sent on another
 * payment, the member is never settled as refunded, disputed or owed nothing,
 * and stays to be tried again. Idea of the identity check: Claude 3's
 * isOwnReply on #3097 and #3098. Checked against a stand-in for Stripe; nothing
 * real is reached.
 */
import { giveBackUnused } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const SUB = "sub_p3097refund";
const INVOICE = "in_p3097mine";
const MINE = "pi_p3097mine";
const OTHER = "pi_p3097other";
let invoiceReply: unknown = {};
let paymentsReply: unknown = {};
let intentReply: unknown = {};
let refundFor: string[] = [];
const goodIntent = (id: string, charge: Record<string, unknown> = {}) => ({
  id,
  amount: 1000,
  currency: "usd",
  latest_charge: { id: "ch_p3097" + id.slice(9), amount: 1000, currency: "usd", amount_refunded: 0, disputed: false, balance_transaction: null, ...charge },
});
const emptyPayments = { object: "list", data: [], has_more: false };
const paidRow = (invoice: string, intent: string) => ({ id: "inpay_p3097", object: "invoice_payment", invoice, status: "paid", payment: { type: "payment_intent", payment_intent: intent } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  if (path === `/invoices/${INVOICE}`) return Response.json(invoiceReply);
  if (path === "/invoice_payments") return Response.json(paymentsReply);
  if (path === `/payment_intents/${MINE}`) return Response.json(intentReply);
  if (path === `/payment_intents/${OTHER}`) return Response.json(goodIntent(OTHER));
  if (path === "/refunds" && init?.method === "POST") {
    const body = new URLSearchParams(String(init.body));
    refundFor.push(String(body.get("payment_intent")));
    return Response.json({ id: "re_p3097", object: "refund", amount: Number(body.get("amount")), currency: "usd", payment_intent: body.get("payment_intent"), status: "succeeded" });
  }
  if (path === "/refunds") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

async function run(label: string, withIntent: boolean) {
  redis.clear();
  refundFor = [];
  const email = `p3097-${label}@example.com`;
  await claimHandle(email, `p3097${label}`, "Refund fixture", "");
  const shop = (await storeForEmail(email))!;
  const seller: Store = { ...shop, stripeAccountId: "acct_p3097refund" };
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: INVOICE, ...(withIntent ? { pi: MINE } : {}), amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 20, "rcalls", 10],
  ]);
  const out = await giveBackUnused(seller, DAY, { final: true });
  const [raw] = await redis.pipeline([["HGET", paidKey(folder), SUB]]);
  const failed = typeof out === "object" ? out.failed : -1;
  return { failed, refundFor: [...refundFor], saved: (JSON.parse(String(raw)) as { r?: string }).r ?? null };
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_p3097_synthetic_only";
  paymentsReply = emptyPayments;
  intentReply = goodIntent(MINE);

  part("the invoice reply is another invoice's");
  invoiceReply = { id: "in_p3097other", object: "invoice", payment_intent: OTHER };
  is("no refund is sent, the member stays to be tried again", await run("otherinvoice", false), { failed: 1, refundFor: [], saved: null });

  part("the invoice reply has no id");
  invoiceReply = { object: "invoice", payment_intent: OTHER };
  is("no refund is sent, the member stays to be tried again", await run("noidinvoice", false), { failed: 1, refundFor: [], saved: null });

  part("the invoice reply is not an object at all");
  invoiceReply = null;
  is("no refund is sent, the member stays to be tried again", await run("nullinvoice", false), { failed: 1, refundFor: [], saved: null });

  part("the invoice names no payment, and its payments do not come as a list");
  invoiceReply = { id: INVOICE, object: "invoice", payment_intent: null };
  paymentsReply = { object: "list" };
  is("never settled as owed nothing; tried again", await run("nolist", false), { failed: 1, refundFor: [], saved: null });

  part("the invoice's payments list a paid row of another invoice");
  paymentsReply = { object: "list", data: [paidRow("in_p3097other", OTHER)], has_more: false };
  is("no refund is sent on the other invoice's payment", await run("otherrow", false), { failed: 1, refundFor: [], saved: null });

  part("the invoice's payments are not whole and none of those read was paid");
  paymentsReply = { object: "list", data: [{ ...paidRow(INVOICE, MINE), status: "open" }], has_more: true };
  is("never settled as owed nothing; tried again", await run("notwhole", false), { failed: 1, refundFor: [], saved: null });

  part("the invoice's own paid payment is found and refunded (control)");
  paymentsReply = { object: "list", data: [paidRow(INVOICE, MINE)], has_more: false };
  is("refunded on this member's own payment", await run("ownrow", false), { failed: 0, refundFor: [MINE], saved: "done" });
  paymentsReply = emptyPayments;

  part("the payment intent reply is another's, disputed");
  invoiceReply = { id: INVOICE, object: "invoice", payment_intent: MINE };
  intentReply = goodIntent(OTHER, { disputed: true });
  is("not settled as disputed from another payment's charge", await run("otherintent", true), { failed: 1, refundFor: [], saved: null });

  part("the payment intent reply has no id, disputed");
  intentReply = { amount: 1000, currency: "usd", latest_charge: { id: "ch_p3097x", amount: 1000, currency: "usd", amount_refunded: 0, disputed: true } };
  is("not settled as disputed from a reply that names no payment", await run("noidintent", true), { failed: 1, refundFor: [], saved: null });

  part("the payment intent reply is not an object at all");
  intentReply = null;
  is("no refund is sent, the member stays to be tried again", await run("nullintent", true), { failed: 1, refundFor: [], saved: null });

  part("the payment intent's charge was not expanded");
  intentReply = { ...goodIntent(MINE), latest_charge: "ch_p3097mine" };
  is("no refund is sent on a charge whose dispute and refunds are unknown", await run("bareintent", true), { failed: 1, refundFor: [], saved: null });

  part("the payment intent's charge has no dispute flag");
  const { disputed: _d, ...noFlag } = goodIntent(MINE).latest_charge;
  void _d;
  intentReply = { ...goodIntent(MINE), latest_charge: noFlag };
  is("no refund is sent while a dispute is unknown", await run("noflag", true), { failed: 1, refundFor: [], saved: null });

  part("the payment intent's charge has no refunded amount");
  const { amount_refunded: _r, ...noRefunded } = goodIntent(MINE).latest_charge;
  void _r;
  intentReply = { ...goodIntent(MINE), latest_charge: noRefunded };
  is("no refund is sent while what was already refunded is unknown", await run("norefunded", true), { failed: 1, refundFor: [], saved: null });

  part("every reply is the one asked for (control)");
  intentReply = goodIntent(MINE);
  is("refunded on this member's own payment", await run("own", true), { failed: 0, refundFor: [MINE], saved: "done" });
  invoiceReply = { id: INVOICE, object: "invoice", payment_intent: MINE };
  is("and found from its own invoice", await run("owninvoice", false), { failed: 0, refundFor: [MINE], saved: "done" });
  done();
}
void main();
