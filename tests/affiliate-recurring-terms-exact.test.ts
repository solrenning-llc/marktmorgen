/** Unknown recurring affiliate terms hold the real book and synthetic payout; known terms stay unchanged. */
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

async function fresh(store: Store): Promise<void> {
  redis.clear();
  created.length = 0;
  refundsBody = EMPTY;
  await redis.pipeline([["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", JSON.stringify({
    id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "",
  })]]);
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("PayPal stand-in not connected");
}
async function isolatedRound(store: Store): Promise<[boolean, boolean, number, number, number]> {
  await fresh(store);
  return round(store);
}
async function isolatedBook(store: Store) {
  await fresh(store);
  return readBook(store);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_recurring_terms_only";
  process.env.RESEND_API_KEY = "re_test_recurring_terms_only";
  const store = shop();
  part("Unread affiliate terms never become a known zero or a skipped membership");
  const terms = (meta: Record<string, unknown>) => ({ parent: { subscription_details: { metadata: meta } } });
  for (const value of [undefined, null, true, 30, "", "unread", "NaN", "Infinity", "-1", "91", "1e1", " 30", "0x1e"]) {
    invoicesBody = list(invoice(terms({ ...META, via_rate: value })));
    is(`plan share ${JSON.stringify(value)}: incomplete, no payout`, await isolatedRound(store), [false, true, 0, 0, 0]);
  }
  for (const value of [undefined, null, 123, "USD", "us", "usd ", "123", {}]) {
    invoicesBody = list(invoice({ currency: value }));
    is(`invoice currency ${JSON.stringify(value)}: incomplete, no payout`, await isolatedRound(store), [false, true, 0, 0, 0]);
  }
  const membership = { ...META, kind: "membership", via_months: "3", via_at: String(NOW - 60) };
  for (const value of [undefined, null, true, 3, "", "unread", "NaN", "Infinity", "-1", "1.5", "1e1", " 3", "0x3", "1201"]) {
    invoicesBody = list(invoice(terms({ ...membership, via_months: value })));
    is(`membership months ${JSON.stringify(value)}: incomplete, no payout`, await isolatedRound(store), [false, true, 0, 0, 0]);
  }
  for (const value of [undefined, null, true, NOW - 60, "", "unread", "NaN", "Infinity", "-1", "0", "1.5", "1e9", ` ${NOW - 60}`]) {
    invoicesBody = list(invoice(terms({ ...membership, via_at: value })));
    is(`membership start ${JSON.stringify(value)}: incomplete, no payout`, await isolatedRound(store), [false, true, 0, 0, 0]);
  }
  for (const [rate, owed] of [["0", 0], ["12.5", 375], ["30", 900], ["90", 2700]] as const) {
    invoicesBody = list(invoice(terms({ ...META, via_rate: rate })));
    const book = await isolatedBook(store);
    is(`known plan share ${rate}: unchanged`, [book.invoicesChecked, book.lines.length, book.rows[0]?.payable], [true, 1, owed]);
  }
  for (const [months, soldAt, expectedLines] of [["3", NOW - 60, 1], ["1200", NOW - 400 * 86_400, 1], ["0", undefined, 0], ["1", NOW - 100 * 86_400, 0]] as const) {
    invoicesBody = list(invoice(terms({ ...membership, via_months: months, via_at: soldAt === undefined ? undefined : String(soldAt) })));
    const book = await isolatedBook(store);
    is(`known membership ${months} months at ${soldAt}: unchanged`, [book.invoicesChecked, book.lines.length, book.rows[0]?.payable], [true, expectedLines, expectedLines * 900]);
  }
  invoicesBody = list(invoice(terms({ ...META, store: "another-store", via_rate: "unread", via_months: "unread" })));
  is("an unrelated store's malformed terms do not hold this book", await isolatedRound(store), [true, true, 0, 0, 0]);

  invoicesBody = list(invoice(terms({ ...META, via_rate: "unread" })));
  await fresh(store);
  await redis.pipeline([["HSET", `nl:aff:${STATS}:sales`, "cs_safe", JSON.stringify({
    ref: "cs_safe", pi: "pi_safe", aff: META.via, at: NOW, product: "p1", title: "Known sale",
    base: 1000, total: 1000, currency: "usd", rate: 30, self: false, how: "click",
  })]]);
  is("an unread renewal holds payout even beside a known payable sale", await round(store), [false, true, 1, 300, 0]);

  done();
}
void main();
