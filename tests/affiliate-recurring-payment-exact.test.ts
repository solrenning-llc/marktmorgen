/**
 * A membership or plan payment earns an affiliate commission only when the
 * payment it was made by, its amount and its tax are read as Stripe gives
 * them (found in the pre-review of claude5/affiliate-refund-list-exact).
 *
 * recurringReferrals named an invoice's payment only when it was an id as
 * text: an expanded payment intent, a charge with no payment intent, a list
 * of payments with more after it or a canceled attempt listed first gave the
 * wrong payment or none, so a refund in full was never matched and PayPal
 * was asked to pay the commission on money the buyer had back. An amount or
 * a tax that could not be read became 0, which dropped the payment without a
 * word or counted its tax as commission. Each is now a payment the book does
 * not count and says so (invoicesChecked false): nothing is paid on it.
 *
 * A refund whose status Stripe gives as null (its API reference documents
 * the status as a nullable string) or as requires_action is money that may
 * go back: it is taken off as a pending one is, and does not stop every
 * other commission of the store from being paid. Only failed and canceled
 * refunds are passed over.
 *
 * All through the real readBook and payWithPayPal, with Stripe and PayPal
 * stood in for by fetch; only the reply bodies change.
 */
import { connectPayPal, payWithPayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsidrp01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const EMPTY = { object: "list", data: [], has_more: false };

let refundsBody: unknown = EMPTY;
let invoicesBody: unknown = EMPTY;
const created: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") {
    if (url.pathname === "/v1/refunds") return json(refundsBody);
    if (url.pathname === "/v1/invoices") return json(invoicesBody);
    return json(EMPTY);
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") {
    return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts openid", expires_in: 32400 });
  }
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    created.push(body);
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidrecpay01",
    handle: "recurpay",
    name: "Recurring Pay",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_1TestRecurPay01",
    currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

const NOW = Math.floor(Date.now() / 1000) - 3600;
const META = { via: "aaaaaaaaaaaa", store: "recurpay", kind: "plan", product: "p1", via_rate: "30" };
const paid = (pi: unknown, over: Record<string, unknown> = {}) => ({ object: "invoice_payment", status: "paid", payment: { type: "payment_intent", payment_intent: pi }, ...over });
const payments = (data: unknown[], over: Record<string, unknown> = {}) => ({ object: "list", data, has_more: false, ...over });

/** One paid plan payment of $30.00 sold through Sara's link, in the shape Stripe gives it (API 2026-08-26.dahlia). */
function invoice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "in_1",
    object: "invoice",
    status: "paid",
    amount_paid: 3000,
    currency: "usd",
    created: NOW,
    status_transitions: { paid_at: NOW },
    total_taxes: [],
    parent: { subscription_details: { metadata: META } },
    payments: payments([paid("pi_inv_1")]),
    ...over,
  };
}

const refund = (over: Record<string, unknown> = {}) => ({ id: "re_1", object: "refund", status: "succeeded", payment_intent: "pi_inv_1", amount: 3000, ...over });
const list = (...data: unknown[]) => ({ object: "list", data, has_more: false });

/** The book and a PayPal round on it: [invoices checked, refunds checked, payment lines, owed now, commissions PayPal was asked to send]. */
async function round(store: Store): Promise<[boolean, boolean, number, number, number]> {
  const book = await readBook(store);
  const before = created.length;
  await payWithPayPal(store);
  // A batch made here (the defect) would hold the line as on its way; cleared so each case is judged on its own.
  await redis.pipeline([["DEL", `nl:pp:open:${STATS}`]]);
  const owed = book.rows.reduce((sum, row) => sum + row.payable, 0);
  return [book.invoicesChecked, book.refundsChecked, book.lines.length, owed, created.length - before];
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_recurring_payment_only";
  process.env.RESEND_API_KEY = "re_test_only";
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
  ]);
  const store = shop();
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("PayPal stand-in not connected");

  part("The payment an invoice was paid by, in each shape Stripe gives it: its refund in full is matched, nothing is paid");
  refundsBody = list(refund());
  for (const [what, pays] of [
    ["its payment intent as an id", payments([paid("pi_inv_1")])],
    ["its payment intent expanded", payments([paid({ id: "pi_inv_1", object: "payment_intent" })])],
    ["a canceled attempt listed before the paid one", payments([paid("pi_old_1", { status: "canceled" }), paid("pi_inv_1")])],
    ["an open attempt listed before the paid one", payments([paid("pi_old_2", { status: "open" }), paid("pi_inv_1")])],
  ] as const) {
    invoicesBody = list(invoice({ payments: pays }));
    is(`${what}: read whole, refunded, nothing owed or sent`, await round(store), [true, true, 1, 0, 0]);
  }

  part("A payment that cannot be named: the invoice is not counted, the book says so, nothing is sent");
  for (const [what, pays] of [
    ["paid by a charge with no payment intent", payments([{ object: "invoice_payment", status: "paid", payment: { type: "charge", charge: "ch_1" } }])],
    ["a list of payments with more after it", payments([paid("pi_inv_1")], { has_more: true })],
    ["a list of payments with has_more absent", { object: "list", data: [paid("pi_inv_1")] }],
    ["payments absent", null],
    ["payments not a list", { object: "list", data: paid("pi_inv_1"), has_more: false }],
    ["a payment row with no status", payments([paid("pi_inv_1", { status: undefined })])],
    ["a payment row with a status Stripe does not give", payments([paid("pi_inv_1", { status: "settled" })])],
    ["two paid payments by different payment intents", payments([paid("pi_inv_1"), paid("pi_inv_9")])],
    ["an expanded payment intent with no id", payments([paid({ object: "payment_intent" })])],
    ["no paid payment at all", payments([paid("pi_old_1", { status: "canceled" })])],
  ] as const) {
    invoicesBody = list(invoice({ payments: pays }));
    is(`${what}: not counted, not checked, nothing sent`, await round(store), [false, true, 0, 0, 0]);
  }

  part("An amount or a tax that cannot be read: the invoice is not counted, the book says so");
  refundsBody = EMPTY;
  for (const [what, over] of [
    ["amount_paid as text", { amount_paid: "3000" }],
    ["amount_paid negative", { amount_paid: -3000 }],
    ["amount_paid a fraction", { amount_paid: 2999.5 }],
    ["amount_paid absent", { amount_paid: undefined }],
    ["a tax amount as text", { total_taxes: [{ amount: "500" }] }],
    ["a tax amount negative", { total_taxes: [{ amount: -500 }] }],
    ["total_taxes not a list", { total_taxes: { amount: 500 } }],
    ["total_taxes absent", { total_taxes: undefined }],
    ["the invoice's id absent", { id: undefined }],
  ] as const) {
    invoicesBody = list(invoice(over));
    is(`${what}: not counted, not checked, nothing sent`, await round(store), [false, true, 0, 0, 0]);
  }

  part("Controls: amounts read whole");
  invoicesBody = list(invoice({ amount_paid: 0 }));
  is("a payment of nothing earns nothing, the book still whole", await round(store), [true, true, 0, 0, 0]);
  invoicesBody = list(invoice({ total_taxes: [{ amount: 500 }] }));
  const taxed = await readBook(store);
  is("the tax is not commission: 30% of $25.00", [taxed.invoicesChecked, taxed.rows[0]?.payable], [true, 750]);

  part("A refund's status: null and requires_action may still go back, failed and canceled did not");
  invoicesBody = list(invoice());
  for (const [what, status, owed] of [
    ["null (Stripe documents the status as nullable)", null, 0],
    ["requires_action", "requires_action", 0],
    ["pending", "pending", 0],
    ["failed", "failed", 900],
    ["canceled", "canceled", 900],
  ] as const) {
    refundsBody = list(refund({ status }));
    const book = await readBook(store);
    is(`a refund in full whose status is ${what}`, [book.refundsChecked, book.rows[0]?.payable], [true, owed]);
  }
  refundsBody = list(refund({ status: 42 }));
  is("a refund whose status is a number is not read: refunds not checked", (await readBook(store)).refundsChecked, false);

  part("Last: everything read whole, the commission is paid once");
  refundsBody = EMPTY;
  invoicesBody = list(invoice());
  const before = created.length;
  const sent = await payWithPayPal(store);
  is("sent, for the payment that was not refunded", sent.ok ? [sent.people, sent.cents, created.length - before] : sent.reason, [1, 900, 1]);

  done();
}

void main();
