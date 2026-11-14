/**
 * An affiliate is paid only on what Stripe said in full about refunds and
 * chargebacks (found reviewing #3048).
 *
 * refundsSince and disputesSince read the creator's Stripe account page by
 * page. A page whose `data` is not a list, whose `has_more` is not a yes or
 * no, that says there is more with no last id to go on from, or a refund or
 * dispute that counts but whose amount or payment cannot be read, used to be
 * read as "every refund, and there are none": refundsChecked stayed true and
 * payWithPayPal sent the commission on a sale the buyer was refunded for or
 * charged back. Each of those now throws, readBook says refundsChecked false,
 * and no PayPal batch is made this round (the next round reads again).
 *
 * The same for the paid invoices recurringReferrals reads: an unreadable page
 * is not "no membership payments", so invoicesChecked is false.
 *
 * All through the real readBook and payWithPayPal, with Stripe and PayPal
 * stood in for by fetch; only the reply bodies change.
 */
import { connectPayPal, payWithPayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsidrl01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const EMPTY = { object: "list", data: [], has_more: false };

let refundsBody: unknown = EMPTY;
let disputesBody: unknown = EMPTY;
let invoicesBody: unknown = EMPTY;
const created: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") {
    if (url.pathname === "/v1/refunds") return json(refundsBody);
    if (url.pathname === "/v1/disputes") return json(disputesBody);
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
    sid: "sidrefund01",
    handle: "refundlist",
    name: "Refund List",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_TestRefund01",
    currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(): Promise<void> {
  redis.clear();
  const at = Math.floor(Date.now() / 1000) - 86_400;
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff: "aaaaaaaaaaaa", at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false })],
  ]);
}

// Rule 23 (merging #3189, which reads refunds and disputes for the book): a counted row now needs its currency,
// as Stripe always gives it, so a refund in another currency is never added to the sale's cents; the rows carry it.
const refund = (over: Record<string, unknown> = {}) => ({ id: "re_1", object: "refund", status: "succeeded", payment_intent: "pi_cs_1", amount: 10000, currency: "usd", ...over });
const dispute = (over: Record<string, unknown> = {}) => ({ id: "dp_1", object: "dispute", status: "lost", payment_intent: "pi_cs_1", amount: 10000, currency: "usd", ...over });

/** Each envelope or row that cannot be read as Stripe gave it, for a list of `row`. */
function unreadable(row: (over?: Record<string, unknown>) => Record<string, unknown>): [string, unknown][] {
  return [
    ["data not a list (an object)", { object: "list", data: row(), has_more: false }],
    ["data not a list (text)", { object: "list", data: "re_1", has_more: false }],
    ["data absent", { object: "list", has_more: false }],
    ["has_more as text", { object: "list", data: [row()], has_more: "false" }],
    ["has_more absent", { object: "list", data: [row()] }],
    ["has_more null", { object: "list", data: [row()], has_more: null }],
    ["more, with no row to go on from", { object: "list", data: [], has_more: true }],
    ["more, with a last row without an id", { object: "list", data: [row({ id: undefined })], has_more: true }],
    ["a row that is not an object", { object: "list", data: [null], has_more: false }],
    ["a counted row whose amount is text", { object: "list", data: [row({ amount: "10000" })], has_more: false }],
    ["a counted row whose amount is negative", { object: "list", data: [row({ amount: -10000 })], has_more: false }],
    ["a counted row whose amount is a fraction", { object: "list", data: [row({ amount: 99.5 })], has_more: false }],
    // Rule 23: a status that is not one Stripe gives a refund or a dispute holds the book for both lists (#3189's
    // reading, which this branch follows): a number, and null, which proves nothing about the money either.
    ["a row whose status is a number", { object: "list", data: [row({ status: 42 })], has_more: false }],
    ["a row whose status is null", { object: "list", data: [row({ status: null })], has_more: false }],
    ["a counted row whose payment is a number", { object: "list", data: [row({ payment_intent: 42 })], has_more: false }],
    ["a counted row whose payment is an object without an id", { object: "list", data: [row({ payment_intent: { object: "payment_intent" } })], has_more: false }],
  ];
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_refund_list_only";
  process.env.RESEND_API_KEY = "re_test_only";
  await seed();
  const store = shop();
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("PayPal stand-in not connected");

  part("Controls: lists Stripe gave whole");
  refundsBody = { object: "list", data: [refund()], has_more: false };
  let book = await readBook(store);
  is("a refund in full, read whole: checked, nothing owed", [book.refundsChecked, book.rows[0]?.payable], [true, 0]);
  let paid = await payWithPayPal(store);
  is("and nothing is paid on it", [paid.ok ? "sent" : paid.reason, created.length], ["nothing", 0]);
  refundsBody = EMPTY;
  disputesBody = { object: "list", data: [dispute()], has_more: false };
  book = await readBook(store);
  is("a lost chargeback in full, read whole: checked, nothing owed", [book.refundsChecked, book.rows[0]?.payable], [true, 0]);
  disputesBody = { object: "list", data: [dispute({ payment_intent: { id: "pi_cs_1", object: "payment_intent" } })], has_more: false };
  book = await readBook(store);
  is("an expanded payment on a chargeback is read by its id", [book.refundsChecked, book.rows[0]?.payable], [true, 0]);
  disputesBody = EMPTY;
  refundsBody = { object: "list", data: [refund({ status: "failed", amount: "n/a" }), refund({ id: "re_2", payment_intent: null, amount: 500 })], has_more: false };
  book = await readBook(store);
  is("a failed refund and one on no payment are passed over, the list still whole", [book.refundsChecked, book.rows[0]?.payable], [true, 3000]);
  refundsBody = EMPTY;

  for (const [list, set, row] of [
    ["refunds", (v: unknown) => { refundsBody = v; }, refund],
    ["disputes", (v: unknown) => { disputesBody = v; }, dispute],
  ] as const) {
    part(`A page of ${list} that cannot be read: no PayPal batch this round`);
    for (const [what, body] of unreadable(row)) {
      set(body);
      const before = created.length;
      const read = await readBook(store);
      const tried = await payWithPayPal(store);
      is(`${list}, ${what}: refunds not checked, no batch sent`, [read.refundsChecked, tried.ok ? "sent" : tried.reason, created.length - before], [false, "refunds", 0]);
      // A batch made here (the defect) would hold the line as on its way; cleared so each case is judged on its own.
      await redis.pipeline([["DEL", `nl:pp:open:${STATS}`]]);
    }
    set(EMPTY);
  }

  part("A page of paid invoices that cannot be read: not 'no membership payments'");
  for (const [what, body] of unreadable((over = {}) => ({ id: "in_1", object: "invoice", status: "paid", amount_paid: 3000, ...over })).slice(0, 8)) {
    invoicesBody = body;
    is(`invoices, ${what}: not checked`, (await readBook(store)).invoicesChecked, false);
  }
  invoicesBody = EMPTY;
  is("invoices, an empty list read whole: checked", (await readBook(store)).invoicesChecked, true);

  part("Last: everything read whole, the commission is paid once");
  const lastBefore = created.length;
  paid = await payWithPayPal(store);
  is("sent, for the sale that was neither refunded nor charged back", paid.ok ? [paid.people, paid.cents, created.length - lastBefore] : paid.reason, [1, 3000, 1]);

  done();
}

void main();
