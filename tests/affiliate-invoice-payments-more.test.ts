/**
 * A paid membership or plan invoice whose expanded `payments` list says there
 * is more (has_more true) is not read whole from that page (third money
 * pre-review of claude5/affiliate-refund-list-exact2, MEDIUM 1).
 *
 * It used to be counted as "unlinked" at once: left out of the book, no
 * commission, invoicesChecked true. But the one paid payment intent can be on
 * the next page (an invoice with ten failed or canceled attempts before the
 * card that paid, say), and the affiliate then lost a commission they earned
 * for good, with the studio saying it earns none. Now the rest is read from
 * GET /v1/invoice_payments?invoice=…&starting_after=… (Stripe's list of an
 * invoice's payments, the URL the expanded list itself names), up to
 * INVOICE_PAYMENT_PAGES more pages an invoice and within the invoice pages the
 * book already waits on (INVOICE_PAGES, so BOOK_STRIPE_PAGES does not move).
 * A list that cannot be followed (no last id to go on from), a page that does
 * not read, one of another invoice, the ceiling or the deadline: not known,
 * invoicesChecked false, never "unlinked". A list already shown to be paid in
 * parts or by a charge is unlinked without asking for more.
 *
 * PROOF C below is the pre-review's proof as given
 * (scratchpad/prerev-affiliate-refund-list-exact2-proof.test.ts); the parts
 * after it are added with the fix's shape.
 */
import { readFileSync } from "node:fs";
import { INVOICE_PAGES, readBook } from "@/lib/affiliates";
import { connectPayPal, payWithPayPal } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsidul01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const EMPTY = { object: "list", data: [], has_more: false };
/** The most pages of one invoice's payments read past its own (INVOICE_PAYMENT_PAGES in lib/affiliates.ts, checked below). */
const INVOICE_PAYMENT_PAGES = 3;

const refundsBody: unknown = EMPTY;
let invoicesBody: unknown = EMPTY;
/** How long the invoice list takes to answer, in milliseconds. */
let invoicesDelay = 0;
const created: Record<string, unknown>[] = [];
/** The pages of /v1/invoice_payments, by "invoice|starting_after"; a missing one answers 404. */
const paymentPages = new Map<string, { status?: number; body: unknown }>();
/** Every /v1/invoice_payments request: its query and its Stripe-Version. */
let askedPayments: { invoice: string | null; after: string | null; limit: string | null; version: string }[] = [];
/** How many /v1/invoices pages were asked. */
let askedInvoices = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") {
    if (url.pathname === "/v1/refunds") return json(refundsBody);
    if (url.pathname === "/v1/invoices") {
      askedInvoices += 1;
      if (invoicesDelay) await new Promise((resolve) => setTimeout(resolve, invoicesDelay));
      return json(invoicesBody);
    }
    if (url.pathname === "/v1/invoice_payments") {
      const invoice = url.searchParams.get("invoice");
      const after = url.searchParams.get("starting_after");
      askedPayments.push({ invoice, after, limit: url.searchParams.get("limit"), version: String((init?.headers as Record<string, string> | undefined)?.["Stripe-Version"] ?? "") });
      const page = paymentPages.get(`${invoice}|${after}`);
      return page ? json(page.body, page.status ?? 200) : json({ error: { message: "No such page" } }, 404);
    }
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

/** Ten canceled attempts of `inv`, each with its id (inpay_<inv>_<page>_<n>), as a page of its payments. */
const tries = (inv: string, page = 0) => Array.from({ length: 10 }, (_, n) => paid(`pi_try_${inv}_${page}_${n}`, { id: `inpay_${inv}_${page}_${n}`, invoice: inv, status: "canceled" }));
const lastTry = (inv: string, page = 0) => `inpay_${inv}_${page}_9`;
/** The paid payment of `inv` by `pi`, as /v1/invoice_payments lists it. */
const paidOf = (inv: string, pi: string) => paid(pi, { id: `inpay_${inv}_paid_${pi}`, invoice: inv });

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_unlinked_only";
  process.env.RESEND_API_KEY = "re_test_only";
  redis.clear();
  await redis.pipeline([["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })]]);
  const store = shop();
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("PayPal stand-in not connected");
  const unlinkedOf = (book: Awaited<ReturnType<typeof readBook>>) => (book as { unlinkedInvoices?: unknown }).unlinkedInvoices;
  const reset = () => {
    paymentPages.clear();
    askedPayments = [];
    askedInvoices = 0;
    invoicesDelay = 0;
  };

  part("The ceiling is the code's");
  is("lib/affiliates.ts reads at most INVOICE_PAYMENT_PAGES more pages of an invoice's payments", readFileSync("lib/affiliates.ts", "utf8").includes(`export const INVOICE_PAYMENT_PAGES = ${INVOICE_PAYMENT_PAGES};`), true);

  part("PROOF C: ten canceled attempts on the page, has_more true: the one paid payment intent is beyond the page");
  const canceled = Array.from({ length: 10 }, (_, n) => paid(`pi_try_${n}`, { status: "canceled" }));
  invoicesBody = list(invoice({ payments: payments(canceled, { has_more: true }) }));
  const book = await readBook(store);
  is("unknown (not read whole) should be invoicesChecked false, not 'paid in parts / no commission'", [book.invoicesChecked, (book as unknown as { unlinkedInvoices?: number }).unlinkedInvoices], [false, 0]);

  part("The paid payment intent on the next page of the invoice's payments: found, linked, its commission paid");
  reset();
  invoicesBody = list(invoice({ payments: payments(tries("in_1"), { has_more: true }) }));
  paymentPages.set(`in_1|${lastTry("in_1")}`, { body: payments([paidOf("in_1", "pi_inv_1")]) });
  const found = await readBook(store);
  is("checked, one line on pi_inv_1, none unlinked", [found.invoicesChecked, found.lines.map((l) => l.pi), unlinkedOf(found)], [true, ["pi_inv_1"], 0]);
  is("asked once, for this invoice, from its last payment, a hundred at a time, on the book's API version", askedPayments, [{ invoice: "in_1", after: lastTry("in_1"), limit: "100", version: "2026-08-26.dahlia" }]);
  const before = created.length;
  const sent = await payWithPayPal(store);
  is("its commission is sent once: 30% of $30.00", sent.ok ? [sent.people, sent.cents, created.length - before] : sent.reason, [1, 900, 1]);
  await redis.pipeline([["DEL", `nl:pp:open:${STATS}`]]);

  part("Followed across pages: the paid one two pages on");
  reset();
  invoicesBody = list(invoice({ id: "in_2", payments: payments(tries("in_2"), { has_more: true }) }));
  paymentPages.set(`in_2|${lastTry("in_2")}`, { body: payments(tries("in_2", 1), { has_more: true }) });
  paymentPages.set(`in_2|${lastTry("in_2", 1)}`, { body: payments([paidOf("in_2", "pi_inv_2")]) });
  const twoOn = await readBook(store);
  is("checked, one line on pi_inv_2, two pages asked", [twoOn.invoicesChecked, twoOn.lines.map((l) => l.pi), unlinkedOf(twoOn), askedPayments.map((a) => a.after)], [true, ["pi_inv_2"], 0, [lastTry("in_2"), lastTry("in_2", 1)]]);

  part("Read whole across pages and paid in parts by two: unlinked, the book still checked");
  reset();
  invoicesBody = list(invoice({ id: "in_3", payments: payments([paidOf("in_3", "pi_part_1"), ...tries("in_3").slice(1)], { has_more: true }) }));
  paymentPages.set(`in_3|${lastTry("in_3")}`, { body: payments([paidOf("in_3", "pi_part_2")]) });
  const parts = await readBook(store);
  is("checked, no line, one unlinked", [parts.invoicesChecked, parts.lines.length, unlinkedOf(parts)], [true, 0, 1]);

  part("Read whole across pages with no paid payment at all: unlinked, the book still checked");
  reset();
  invoicesBody = list(invoice({ id: "in_4", payments: payments(tries("in_4"), { has_more: true }) }));
  paymentPages.set(`in_4|${lastTry("in_4")}`, { body: payments(tries("in_4", 1)) });
  const none = await readBook(store);
  is("checked, no line, one unlinked", [none.invoicesChecked, none.lines.length, unlinkedOf(none)], [true, 0, 1]);

  part("Already paid in parts on the first page: unlinked without asking for more");
  reset();
  invoicesBody = list(invoice({ id: "in_5", payments: payments([paid("pi_a"), paid("pi_b")], { has_more: true }) }));
  const early = await readBook(store);
  is("checked, one unlinked, nothing more asked", [early.invoicesChecked, unlinkedOf(early), askedPayments.length], [true, 1, 0]);

  part("Not known, never unlinked: the book is not checked and nothing is paid on it");
  for (const [what, inv, setPages] of [
    ["the next page is not found (404)", "in_6", () => undefined],
    ["the next page is not a list", "in_7", () => paymentPages.set(`in_7|${lastTry("in_7")}`, { body: { object: "list", data: paidOf("in_7", "pi_7"), has_more: false } })],
    ["the next page says nothing of has_more", "in_8", () => paymentPages.set(`in_8|${lastTry("in_8")}`, { body: { object: "list", data: [paidOf("in_8", "pi_8")] } })],
    ["the next page is not an object list", "in_9", () => paymentPages.set(`in_9|${lastTry("in_9")}`, { body: { object: "invoice", data: [paidOf("in_9", "pi_9")], has_more: false } })],
    ["the next page lists another invoice's payment", "in_10", () => paymentPages.set(`in_10|${lastTry("in_10")}`, { body: payments([paidOf("in_99", "pi_10")]) })],
    ["the next page lists a row with no id", "in_11", () => paymentPages.set(`in_11|${lastTry("in_11")}`, { body: payments([paid("pi_11", { invoice: "in_11" })]) })],
    ["the next page lists a row that is not an invoice payment", "in_12", () => paymentPages.set(`in_12|${lastTry("in_12")}`, { body: payments([{ ...paidOf("in_12", "pi_12"), object: "charge" }]) })],
    ["the next page says there is more, with an empty page", "in_13", () => paymentPages.set(`in_13|${lastTry("in_13")}`, { body: payments([], { has_more: true }) })],
  ] as const) {
    reset();
    setPages();
    // Beside it, an invoice that links on its own page: its line stays, the book is not checked all the same.
    invoicesBody = list(invoice({ id: inv, payments: payments(tries(inv), { has_more: true }) }), invoice({ id: "in_ok", payments: payments([paid("pi_ok")]) }));
    const read = await readBook(store);
    is(`${what}: not checked, none unlinked, the other invoice's line kept`, [read.invoicesChecked, unlinkedOf(read), read.lines.map((l) => l.pi)], [false, 0, ["pi_ok"]]);
  }

  part("Past the ceiling of pages an invoice: not known, and no page past it is asked");
  reset();
  invoicesBody = list(invoice({ id: "in_20", payments: payments(tries("in_20"), { has_more: true }) }));
  for (let page = 0; page <= INVOICE_PAYMENT_PAGES; page += 1) paymentPages.set(`in_20|${lastTry("in_20", page)}`, { body: payments(tries("in_20", page + 1), { has_more: true }) });
  const ceiling = await readBook(store);
  is("not checked, none unlinked, INVOICE_PAYMENT_PAGES pages asked", [ceiling.invoicesChecked, unlinkedOf(ceiling), askedPayments.length], [false, 0, INVOICE_PAYMENT_PAGES]);

  part("Within the invoice pages the book already waits on: invoice and payment pages together never pass INVOICE_PAGES");
  reset();
  const many = Array.from({ length: 6 }, (_, k) => `in_m${k}`);
  invoicesBody = list(...many.map((id) => invoice({ id, payments: payments(tries(id), { has_more: true }) })));
  for (const id of many) for (let page = 0; page <= INVOICE_PAYMENT_PAGES; page += 1) paymentPages.set(`${id}|${lastTry(id, page)}`, { body: payments(tries(id, page + 1), { has_more: true }) });
  const shared = await readBook(store);
  is("not checked, none unlinked, at most INVOICE_PAGES Stripe pages for invoices and their payments", [shared.invoicesChecked, unlinkedOf(shared), askedInvoices + askedPayments.length <= INVOICE_PAGES, askedInvoices + askedPayments.length], [false, 0, true, INVOICE_PAGES]);

  part("The deadline: no page of payments is asked past it, and that is not known, not unlinked");
  reset();
  invoicesDelay = 700;
  invoicesBody = list(invoice({ id: "in_30", payments: payments(tries("in_30"), { has_more: true }) }));
  paymentPages.set(`in_30|${lastTry("in_30")}`, { body: payments([paidOf("in_30", "pi_inv_30")]) });
  const late = await readBook(store, undefined, { deadline: Date.now() + 1_500 });
  is("not checked, none unlinked, no payments page asked", [late.invoicesChecked, unlinkedOf(late), askedPayments.length], [false, 0, 0]);

  done();
}
void main();
