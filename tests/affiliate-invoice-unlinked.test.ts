/**
 * A paid membership or plan invoice that Stripe gives whole but that cannot be
 * linked to one payment intent (paid in parts by two, by a charge with no
 * payment intent, by a payment record, or no paid payment listed, its
 * payments read to the end: tests/affiliate-invoice-payments-more.test.ts) is
 * not a reading that failed: reloading does not
 * change it (second money pre-review of claude5/affiliate-refund-list-exact).
 *
 * It used to set invoicesChecked false, so the studio said "reload to try
 * again" for good, which never helped (VR 2), every campaign result was
 * hidden for every affiliate of the store, and the kept book was worked out
 * again as incomplete. Now it is left out of the book and counted
 * (unlinkedInvoices): no commission on it, invoicesChecked stays true, and the
 * studio says plainly that it earns no commission. An invoice that cannot be
 * read is still not checked, as before.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AffiliateCommissionHistory } from "@/components/affiliate-commission-history";
import { connectPayPal, payWithPayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsidul01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const EMPTY = { object: "list", data: [], has_more: false };

const refundsBody: unknown = EMPTY;
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
    sid: "sidunlink01",
    handle: "recurpay",
    name: "Recurring Pay",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_1TestUnlinked01",
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

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_unlinked_only";
  process.env.RESEND_API_KEY = "re_test_only";
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${STATS}:people`, "bbbbbbbbbbbb", JSON.stringify({ id: "bbbbbbbbbbbb", email: "ben@example.com", code: "ben", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
  ]);
  const store = shop();
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("PayPal stand-in not connected");
  const unlinkedOf = (book: Awaited<ReturnType<typeof readBook>>) => (book as { unlinkedInvoices?: unknown }).unlinkedInvoices;

  part("Read whole but with no one payment to link it to: out of the book, counted, the book still checked");
  for (const [what, pays] of [
    ["paid in parts by two payment intents", payments([paid("pi_inv_1"), paid("pi_inv_9")])],
    ["paid by a charge with no payment intent", payments([{ object: "invoice_payment", status: "paid", payment: { type: "charge", charge: "ch_1" } }])],
    ["paid by a payment record", payments([{ object: "invoice_payment", status: "paid", payment: { type: "payment_record", payment_record: "pr_1" } }])],
    // Moved to the controls below (rule 23; third money pre-review of claude5/affiliate-refund-list-exact2): a page
    // saying there is more is followed (tests/affiliate-invoice-payments-more.test.ts), so "more than the page shows"
    // is no longer unlinked; it is unlinked only once read to the end.
    ["no paid payment listed", payments([])],
    ["only a canceled attempt listed", payments([paid("pi_old_1", { status: "canceled" })])],
  ] as const) {
    invoicesBody = list(invoice({ payments: pays }));
    const before = created.length;
    const book = await readBook(store);
    await payWithPayPal(store);
    await redis.pipeline([["DEL", `nl:pp:open:${STATS}`]]);
    is(`${what}: checked, no line, one unlinked, nothing sent`, [book.invoicesChecked, book.refundsChecked, book.lines.length, unlinkedOf(book), created.length - before], [true, true, 0, 1, 0]);
  }

  part("Beside a payment that links: that one is paid, the other is not");
  invoicesBody = list(invoice(), invoice({ id: "in_2", payments: payments([paid("pi_inv_2"), paid("pi_inv_3")]) }));
  const both = await readBook(store);
  is("one line, one unlinked, the book checked", [both.invoicesChecked, both.lines.length, unlinkedOf(both)], [true, 1, 1]);
  is("another affiliate's part counts none of Sara's", unlinkedOf(await readBook(store, "bbbbbbbbbbbb")), 0);
  const before = created.length;
  const sent = await payWithPayPal(store);
  is("the linked payment's commission is sent once", sent.ok ? [sent.people, sent.cents, created.length - before] : sent.reason, [1, 900, 1]);

  part("Controls: an invoice that cannot be read is still not checked, and not counted as unlinked");
  for (const [what, over] of [
    ["payments absent", { payments: null }],
    ["payments not a list", { payments: { object: "list", data: paid("pi_inv_1"), has_more: false } }],
    ["has_more absent on its payments", { payments: { object: "list", data: [paid("pi_inv_1")] } }],
    // Moved here from the part above (rule 23): more payments than the page shows, with no last id to go on from, is
    // not known, never unlinked (third money pre-review of claude5/affiliate-refund-list-exact2).
    ["more payments than the page shows, with no last id to go on from", { payments: payments([paid("pi_inv_1")], { has_more: true }) }],
    ["a payment row with a status Stripe does not give", { payments: payments([paid("pi_inv_1", { status: "settled" })]) }],
    ["a paid payment intent row with no id", { payments: payments([paid({ object: "payment_intent" })]) }],
    ["amount_paid as text", { amount_paid: "3000" }],
  ] as const) {
    invoicesBody = list(invoice({ id: "in_9", ...over }));
    const book = await readBook(store);
    is(`${what}: not checked, none unlinked`, [book.invoicesChecked, book.lines.length, unlinkedOf(book)], [false, 0, 0]);
  }

  part("The studio says it plainly, without promising a reload");
  const history = (unlinkedInvoices: number, invoicesChecked = true) =>
    renderToStaticMarkup(createElement(AffiliateCommissionHistory, { lines: [], total: 0, who: new Map(), refundsChecked: true, invoicesChecked, unlinkedInvoices } as Parameters<typeof AffiliateCommissionHistory>[0]));
  const one = history(1);
  is("one: named, no commission, no reload", [one.includes("1 membership or plan payment could not be linked"), one.includes("earns no commission"), /reload/i.test(one)], [true, true, false]);
  const three = history(3);
  is("three: in the plural", [three.includes("3 membership or plan payments could not be linked"), three.includes("They earn no commission")], [true, true]);
  is("none: nothing said", history(0).includes("could not be linked"), false);

  done();
}

void main();
