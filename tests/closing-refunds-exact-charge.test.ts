// A closing refund decides only from Stripe's answers read exactly (CX-123 rules 24 and 30; Claude 5, 07/11/2026):
// the invoice's payments are a list read whole before "no payment" is said, and the charge is read in its own shape
// before what was already refunded is subtracted. Anything else is unknown: nothing is sent, the member is not settled,
// and the next run reads it again. Synthetic Stripe only.
import { giveBackUnused, unusedRows } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const SUB = "sub_c5exactcharge";
const INVOICE = "in_c5exactcharge";
const INTENT = "pi_c5exactcharge";
const goodCharge = { id: "ch_c5exactcharge", object: "charge", amount: 1000, currency: "usd", amount_refunded: 0, disputed: false };

let payments: unknown = null;
let latest: unknown = goodCharge;
let posts: number[] = [];
let reads: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  reads.push(`${method} ${path}`);
  if (path === "/balance") return Response.json({ available: [{ amount: 100_000, currency: "usd" }] });
  // The invoice no longer names its payment (newer API versions): its payments are listed.
  if (path === `/invoices/${INVOICE}`) return Response.json({ id: INVOICE, object: "invoice", status: "paid" });
  if (path === "/invoice_payments") return Response.json(payments);
  if (path === `/payment_intents/${INTENT}`) return Response.json({ id: INTENT, object: "payment_intent", latest_charge: latest });
  if (path === "/refunds" && method === "GET") return Response.json({ object: "list", data: [], has_more: false });
  if (path === "/refunds" && method === "POST") {
    const amount = Number(new URLSearchParams(String(init?.body)).get("amount"));
    posts.push(amount);
    return Response.json({ id: "re_c5exactcharge", object: "refund", amount, currency: "usd", payment_intent: INTENT, status: "succeeded" });
  }
  return Response.json({ error: { message: `unexpected synthetic request ${method} ${path}` } }, { status: 404 });
}) as typeof fetch;

let n = 0;
async function run(label: string, opts: { pi?: boolean; payments?: unknown; charge?: unknown }) {
  redis.clear();
  posts = [];
  reads = [];
  payments = opts.payments ?? null;
  latest = opts.charge === undefined ? goodCharge : opts.charge;
  n += 1;
  const email = `c5-exact-${n}@example.com`;
  await claimHandle(email, `c5exact${n}`, "Exact charge fixture", "");
  const shop = (await storeForEmail(email))!;
  const seller: Store = { ...shop, stripeAccountId: "acct_c5exactcharge" };
  const folder = await storeFolder(email);
  // Half of a 1,000-cent period is unused on the closing day: 500 to give back.
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: INVOICE, ...(opts.pi ? { pi: INTENT } : {}), amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 20, "rcalls", 10],
  ]);
  const out = await giveBackUnused(seller, DAY, { final: true });
  const [raw] = await redis.pipeline([["HGET", paidKey(folder), SUB]]);
  const saved = JSON.parse(String(raw)) as { r?: string };
  const remaining = (await unusedRows(seller, DAY)).length;
  const failed = typeof out === "object" ? out.failed : -1;
  console.log(JSON.stringify({ label, posts, saved: saved.r ?? null, failed, remaining }));
  return { posts, saved: saved.r ?? null, failed, remaining };
}

const unknownStays = (label: string, r: Awaited<ReturnType<typeof run>>) => {
  is(`${label}: nothing is sent`, r.posts, []);
  is(`${label}: the member is not settled, and is read again next run`, [r.saved, r.remaining, r.failed], [null, 1, 1]);
};

const paidRow = { id: "inpay_c5exact1", object: "invoice_payment", status: "paid", payment: { type: "payment_intent", payment_intent: INTENT } };
const failedRow = { id: "inpay_c5exact0", object: "invoice_payment", status: "failed", payment: { type: "payment_intent", payment_intent: "pi_c5otherattempt" } };

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_c5_exact_synthetic_only";

  // Controls: the readable answers keep doing what they did.
  const paid = await run("payments-paid", { payments: { object: "list", data: [failedRow, paidRow], has_more: false } });
  is("control: the paid payment's intent is refunded its unused 500", [paid.posts, paid.saved], [[500], "done"]);
  const none = await run("payments-none", { payments: { object: "list", data: [failedRow], has_more: false } });
  is("control: a whole list with no paid payment is 'none'", [none.posts, none.saved, none.remaining], [[], "none", 0]);
  const viaCharge = await run("payments-by-charge", { payments: { object: "list", data: [{ id: "inpay_c5exact2", object: "invoice_payment", status: "paid", payment: { type: "charge", charge: "ch_c5legacy" } }], has_more: false } });
  is("control: a paid payment that is not a PaymentIntent is 'none', as before", [viaCharge.posts, viaCharge.saved], [[], "none"]);
  const known = await run("charge-known-refunded", { pi: true, charge: { ...goodCharge, amount_refunded: 300 } });
  is("control: 300 already refunded by the creator leaves 200 to give", [known.posts, known.saved], [[200], "done"]);

  // The invoice's payments, unreadable or not read whole: never "no payment".
  unknownStays("payments: data is not a list", await run("payments-data-text", { payments: { object: "list", data: "x", has_more: false } }));
  unknownStays("payments: has_more missing", await run("payments-no-has-more", { payments: { object: "list", data: [] } }));
  unknownStays("payments: has_more in text", await run("payments-has-more-text", { payments: { object: "list", data: [], has_more: "false" } }));
  unknownStays("payments: more past this page, none paid on it", await run("payments-more", { payments: { object: "list", data: [failedRow], has_more: true } }));
  unknownStays("payments: a row that is null", await run("payments-null-row", { payments: { object: "list", data: [null], has_more: false } }));
  unknownStays("payments: a row with no status", await run("payments-no-status", { payments: { object: "list", data: [{ id: "inpay_c5exact3", payment: paidRow.payment }], has_more: false } }));
  unknownStays("payments: a paid row whose payment is not an object", await run("payments-payment-text", { payments: { object: "list", data: [{ ...paidRow, payment: "garbled" }], has_more: false } }));
  unknownStays("payments: a paid row whose intent is not an id", await run("payments-bad-intent", { payments: { object: "list", data: [{ ...paidRow, payment: { type: "payment_intent", payment_intent: 7 } }], has_more: false } }));
  unknownStays("payments: not an object", await run("payments-null", { payments: null }));

  // The charge, read in its own shape before what is still to give is worked out.
  unknownStays("charge: amount_refunded missing (the creator's earlier refund would be given again)", await run("charge-no-refunded", { pi: true, charge: { ...goodCharge, amount_refunded: undefined } }));
  unknownStays("charge: amount_refunded in text", await run("charge-refunded-text", { pi: true, charge: { ...goodCharge, amount_refunded: "300" } }));
  unknownStays("charge: amount_refunded negative", await run("charge-refunded-negative", { pi: true, charge: { ...goodCharge, amount_refunded: -1 } }));
  unknownStays("charge: not expanded (an id only)", await run("charge-id-only", { pi: true, charge: "ch_c5exactcharge" }));
  unknownStays("charge: missing", await run("charge-missing", { pi: true, charge: null }));
  unknownStays("charge: disputed not true or false", await run("charge-disputed-text", { pi: true, charge: { ...goodCharge, disputed: "false" } }));
  unknownStays("charge: currency missing", await run("charge-no-currency", { pi: true, charge: { ...goodCharge, currency: undefined } }));
  unknownStays("charge: currency not the payment's", await run("charge-other-currency", { pi: true, charge: { ...goodCharge, currency: "eur" } }));
  done();
}
void main();
