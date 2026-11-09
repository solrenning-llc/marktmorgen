/**
 * A store's membership and plan payments sold through an affiliate are all in
 * the affiliate book, however many paid invoices the creator's Stripe account
 * has (audit of Stripe lists with a page ceiling, 9 November 2026, A1).
 *
 * recurringReferrals read every paid invoice of the account since the oldest
 * affiliate joined, newest first, from the first page every time, up to
 * INVOICE_PAGES pages of a hundred. Past a thousand, only the newest were
 * read: an affiliate's older renewals fell out of the book, `earned` dropped
 * (and `owed = earned - paid` with it, below zero after a payout), and the
 * book said invoicesChecked false while the automatic PayPal payout and the
 * payday looked only at refundsChecked: the affiliate was paid less, by
 * itself, with no word to anyone.
 *
 * Now (1) nothing is paid by itself, nor a batch recorded, on a book whose
 * invoices were not all read, with an honest word in the studio and the
 * emails; (2) the paid invoices already read whole are kept between readings
 * (one record a store, INVOICE_KEPT_MAX_BYTES at the most), read on from where
 * the last reading stopped, so every one is reached in a bounded number of
 * readings within the same INVOICE_PAGES pages each; the newest are read again
 * every time, and the kept ones are read again whole every
 * INVOICE_REBUILD_SECONDS, so an old invoice paid late is counted then.
 *
 * PROOF A1 below is the audit's proof (scratchpad/auditoria-buscas-stripe.md,
 * proof-aff-invoices.test.ts) with readings repeated; the parts after it are
 * added with the fix's shape. Synthetic data, Stripe, PayPal and Resend stand-ins.
 */
import { NextRequest } from "next/server";
import { NO_AFFILIATES, RECURRING_ALWAYS } from "@/lib/affiliate-setting";
import { INVOICE_PAGES, INVOICES_KEPT_MAX_LINES, readBook } from "@/lib/affiliates";
import { autoPayEmail, paydayEmail, sendPaydayEmails } from "@/lib/affiliate-payday";
import { connectPayPal, payWithPayPal, setAutoPay } from "@/lib/paypal-payouts";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { POST as recordBatch } from "@/app/api/store/affiliates/payout-batch/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_recurring_complete_only";
process.env.RESEND_API_KEY = "re_test_recurring_complete_only";

const OWNER = "owner@example.com";
const DAY = 86_400;
const REAL_NOW = Date.now;
/** How far the test has moved the clock, in milliseconds. */
let shift = 0;
Date.now = () => REAL_NOW() + shift;
const NOW = Math.floor(REAL_NOW() / 1000);
const SARA = "0123456789ab";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";

/** Every invoice of the creator's account, newest first, as Stripe lists them. */
let all: Record<string, unknown>[] = [];
/** The invoice list answers in a shape that does not read. */
let unreadable = false;
/** Stripe pages asked (invoices and invoice payments) since the last reset. */
let asked = 0;
const payouts: Record<string, unknown>[] = [];
const emails: { subject: string; text: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { subject?: string; text?: string };
    emails.push({ subject: String(body.subject), text: String(body.text) });
    return answer({ id: `email_${emails.length}` });
  }
  if (url.hostname === "api-m.paypal.com") {
    if (url.pathname === "/v1/oauth2/token") return answer({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts openid", expires_in: 32400 });
    if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      payouts.push(body);
      return answer({ batch_header: { payout_batch_id: `BATCH${payouts.length}ABC`, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
    }
    return answer({ name: "RESOURCE_NOT_FOUND" }, 404);
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/invoices") {
    asked += 1;
    if (unreadable) return answer({ object: "list", has_more: false });
    const q = url.searchParams;
    const num = (name: string) => (q.has(name) ? Number(q.get(name)) : null);
    const [gte, gt, lte, lt] = [num("created[gte]"), num("created[gt]"), num("created[lte]"), num("created[lt]")];
    const rows = all.filter((i) => {
      const at = Number(i.created);
      return (!q.get("status") || i.status === q.get("status")) && (gte === null || at >= gte) && (gt === null || at > gt) && (lte === null || at <= lte) && (lt === null || at < lt);
    });
    const after = q.get("starting_after");
    const from = after ? rows.findIndex((i) => i.id === after) + 1 : 0;
    if (after && from === 0) return answer({ error: { message: "No such invoice" } }, 400);
    const limit = Number(q.get("limit") ?? 10);
    return answer({ object: "list", data: rows.slice(from, from + limit), has_more: from + limit < rows.length });
  }
  if (path === "/invoice_payments") asked += 1;
  if ((init?.method ?? "GET") === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({}, 404);
}) as typeof fetch;

const inv = (id: string, at: number, meta: Record<string, string>, status = "paid") => ({
  id, object: "invoice", status, billing_reason: "subscription_cycle", amount_paid: status === "paid" ? 2000 : 0, currency: "usd", customer_email: "m@example.com",
  created: at, status_transitions: { paid_at: status === "paid" ? at : null }, total_taxes: [],
  parent: { subscription_details: { metadata: { store: "harbor", ...meta } } },
  payments: { object: "list", has_more: false, data: status === "paid" ? [{ object: "invoice_payment", status: "paid", payment: { type: "payment_intent", payment_intent: `pi_${id}` } }] : [] },
});

async function setUp(plan = true): Promise<{ product: string }> {
  redis.clear();
  shift = 0;
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  if (plan) await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "creator", period: paidPeriod() });
  const club = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30, recurring: RECURRING_ALWAYS, hold: 0, payday: new Date().getUTCDate() });
  const store = (await storeForEmail(OWNER))!;
  await redis.pipeline([["HSET", `nl:aff:${store.statsId}:people`, SARA, JSON.stringify({ id: SARA, email: "sara@example.com", paypal: "sara.pay@example.com", code: "sara", status: "approved", appliedAt: (NOW - 400 * DAY) * 1000, decidedAt: 1, note: "" })]]);
  return { product: club.product.id };
}

const sara = async () => {
  const book = await readBook((await storeForEmail(OWNER))!);
  return { earned: book.rows.find((r) => r.affiliate.id === SARA)?.earned ?? 0, whole: book.invoicesChecked, refunds: book.refundsChecked };
};

/** Reads the book until it says it read every invoice, at most `most` times; each reading's Stripe pages, and the last book. */
async function readUntilWhole(most: number): Promise<{ readings: number; pages: number[]; earned: number; whole: boolean }> {
  const pages: number[] = [];
  let last = { earned: 0, whole: false, refunds: true };
  for (let n = 1; n <= most; n += 1) {
    asked = 0;
    last = await sara();
    pages.push(asked);
    if (last.whole) return { readings: n, pages, earned: last.earned, whole: true };
  }
  return { readings: most, pages, earned: last.earned, whole: last.whole };
}

async function main(): Promise<void> {
  part("PROOF A1: Sara's older renewals are past the 1,000 newest paid invoices");
  const { product } = await setUp();
  const terms = { product, via: SARA, via_rate: "30", via_months: String(RECURRING_ALWAYS), via_at: String(NOW - 300 * DAY) };
  // Newest first, as Stripe lists them: 1,000 renewals of members who came with no affiliate, then 50 renewals Sara earned.
  all = [];
  for (let i = 0; i < 1000; i += 1) all.push(inv(`in_Other${String(i).padStart(6, "0")}`, NOW - 1000 - i, { product }));
  for (let i = 0; i < 50; i += 1) all.push(inv(`in_Sara0${String(i).padStart(6, "0")}`, NOW - 200 * DAY - i, terms));
  const first = await readUntilWhole(4);
  is("whole within four readings, every renewal Sara earned on the book (50 x 600 cents)", [first.whole, first.earned], [true, 50 * 600]);
  is("never more than INVOICE_PAGES Stripe pages a reading", first.pages.every((n) => n <= INVOICE_PAGES), true);

  part("Read whole once, a later reading reads only what is newer and stays whole");
  // Made after the reading that read the book whole (a renewal a minute later), as a new one is.
  all.unshift(inv("in_Sara1000001", NOW + 60, terms));
  shift = 120_000;
  asked = 0;
  is("the new renewal is counted at once, the book whole", await sara(), { earned: 51 * 600, whole: true, refunds: true });
  is("on a page or two, not the whole account again", asked <= 2, true);

  part("An old invoice paid late is counted once the kept invoices are read again");
  const { product: p2 } = await setUp();
  const terms2 = { product: p2, via: SARA, via_rate: "30", via_months: String(RECURRING_ALWAYS), via_at: String(NOW - 300 * DAY) };
  all = [];
  for (let i = 0; i < 1000; i += 1) all.push(inv(`in_Other${String(i).padStart(6, "0")}`, NOW - 1000 - i, { product: p2 }));
  const late = inv("in_SaraLate001", NOW - 150 * DAY, terms2, "open");
  all.push(late);
  for (let i = 0; i < 50; i += 1) all.push(inv(`in_Sara0${String(i).padStart(6, "0")}`, NOW - 200 * DAY - i, terms2));
  const before = await readUntilWhole(4);
  is("whole before the late payment, 50 renewals", [before.whole, before.earned], [true, 50 * 600]);
  all[all.indexOf(late)] = inv("in_SaraLate001", NOW - 150 * DAY, terms2);
  shift = 2 * DAY * 1000;
  let caught = 0;
  for (let n = 0; n < 6 && caught !== 51 * 600; n += 1) {
    const read = await sara();
    if (read.whole) caught = read.earned;
  }
  is("past the rebuild, the late payment is on a whole book", caught, 51 * 600);

  part("A kept record that does not read is never an empty one");
  const { product: p3 } = await setUp();
  const terms3 = { product: p3, via: SARA, via_rate: "30", via_months: String(RECURRING_ALWAYS), via_at: String(NOW - 300 * DAY) };
  all = [];
  for (let i = 0; i < 1000; i += 1) all.push(inv(`in_Other${String(i).padStart(6, "0")}`, NOW - 1000 - i, { product: p3 }));
  for (let i = 0; i < 50; i += 1) all.push(inv(`in_Sara0${String(i).padStart(6, "0")}`, NOW - 200 * DAY - i, terms3));
  await readUntilWhole(4);
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  for (const garbage of ["not json", "{}", JSON.stringify({ v: 1, since: 0 }), JSON.stringify({ v: 999, since: 0, handles: "harbor", kept: { top: NOW, at: NOW, whole: true, lines: [], unlinked: [] }, walk: null }), JSON.stringify({ v: 1, since: 0, handles: "harbor", kept: { top: "soon", whole: true }, walk: null })]) {
    await redis.pipeline([["SET", `nl:aff:${statsId}:invoices`, garbage]]);
    const read = await sara();
    is(`kept as ${garbage.slice(0, 40)}: not whole with less than Sara earned`, read.whole && read.earned < 50 * 600, false);
  }

  part("Past the ceiling (INVOICES_KEPT_MAX_LINES invoices kept), the book never says it read them all");
  const { product: p4 } = await setUp();
  const terms4 = { product: p4, via: SARA, via_rate: "30", via_months: String(RECURRING_ALWAYS), via_at: String(NOW - 300 * DAY) };
  all = [];
  for (let i = 0; i <= INVOICES_KEPT_MAX_LINES; i += 1) all.push(inv(`in_Many${String(i).padStart(7, "0")}`, NOW - 1000 - i, terms4));
  let claimed = false;
  for (let n = 0; n < 12; n += 1) if ((await sara()).whole) claimed = true;
  is("twelve readings, never whole", claimed, false);
  all.pop();
  const fits = await readUntilWhole(12);
  is("at the ceiling itself, whole and every one counted", [fits.whole, fits.earned], [true, INVOICES_KEPT_MAX_LINES * 600]);

  part("Invoices not all read: nothing is paid from PayPal by itself, nor a batch recorded");
  // No plan, as the payday email's own test (tests/opt-out-exact.test.ts): the email is counted against the store's figure.
  await setUp(false);
  const store = (await storeForEmail(OWNER))!;
  await redis.pipeline([["HSET", `nl:aff:${store.statsId}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff: SARA, at: NOW - 100 * DAY, product: "prod01", title: "Bread course", base: 10000, total: 10000, currency: "usd", rate: 30, self: false, how: "click" })]]);
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("PayPal stand-in not connected");
  all = [];
  unreadable = true;
  const book = await readBook(store);
  is("the book: invoices not checked, refunds checked, Sara owed 3,000", [book.invoicesChecked, book.refundsChecked, book.rows.find((r) => r.affiliate.id === SARA)?.payable], [false, true, 3000]);
  await setAutoPay(store, true);
  emails.length = 0;
  payouts.length = 0;
  asked = 0;
  const day = await sendPaydayEmails(Date.now() + 20_000);
  is("payday pays nobody by itself", payouts.length, 0);
  // Paying by itself reads the book a second time (payWithPayPal) before it is refused; the email to pay by hand does
  // not. The email itself is not sent here (no mail transport is proven in this harness: lib/email.ts,
  // serviceMailKnownUnavailable), so its words are checked on paydayEmail below.
  is("payday, due, takes the way to pay by hand: the book read once", [day.due, day.failed, asked], [1, 0, 1]);
  // Then the press, on the same book.
  is("one press sends nothing and says why", await payWithPayPal(store), { ok: false, reason: "invoices" });
  is("no payout asked of PayPal", payouts.length, 0);
  const session = await openSession(OWNER);
  const recorded = await recordBatch(new NextRequest("https://marktmorgen.com/api/store/affiliates/payout-batch", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ date: new Date().toISOString().slice(0, 10), reference: "PayPal batch 1" }) }));
  is("a batch is not recorded against it", [recorded.status, ((await recorded.json()) as { error?: string }).error], [409, "invoices"]);
  unreadable = false;

  part("What the creator is told");
  const auto = autoPayEmail({ ok: false, reason: "invoices" } as Parameters<typeof autoPayEmail>[0], "usd");
  is("the email says the membership and plan payments could not all be checked", /could not check every membership and plan payment/.test(auto.text), true);
  const manual = paydayEmail({ storeName: "Harbor", payday: 5, people: 1, totalCents: 100, currency: "usd", waitingCents: 0, hold: 0, refundsChecked: true, invoicesChecked: false } as Parameters<typeof paydayEmail>[0]);
  is("the payday email says so too", /membership and plan payments/.test(manual.text), true);
  const fine = paydayEmail({ storeName: "Harbor", payday: 5, people: 1, totalCents: 100, currency: "usd", waitingCents: 0, hold: 0, refundsChecked: true, invoicesChecked: true } as Parameters<typeof paydayEmail>[0]);
  is("and not when they were", /membership and plan payments/.test(fine.text), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
