/**
 * The daily settling of moves to the monthly price (630 [HN6](14), unit 2c;
 * added 4 November 2026; lib/yearly-fallback-sweep.ts), against a stand-in
 * Stripe that keeps its own state and the in-memory Redis double only.
 * Checked, for each of the three lists moveToMonthly leaves:
 *
 *   - VOID: an open year is voided; a void one is only taken off; a year paid
 *     meanwhile goes to BOTH and has its month refunded the same run;
 *   - CHECK: moved with the month paid, the year is voided; the month not
 *     paid yet, it waits, and after FALLBACK_CHECK_DAYS the year is left open
 *     and never retried; still yearly with a pending update, it waits; still
 *     yearly with none, the year is retried again; the year paid while moved
 *     goes to BOTH;
 *   - BOTH: the membership goes back to the year's own price with nothing
 *     charged until the year paid ends, the month is refunded in full, never
 *     more than is left on its charge, never twice (a second run, a refund
 *     found made, a failure halfway), never when disputed; a month still owed
 *     is voided instead; the creator gets one note;
 *   - no answer from Stripe keeps a member for tomorrow; a second run does
 *     nothing more; the deadline and the per-run cap are kept; the daily
 *     recovery job runs it first.
 */
import { FALLBACK_BOTH_KEY, FALLBACK_CHECK_KEY, FALLBACK_STORES_KEY, FALLBACK_STRIPE_VERSION, FALLBACK_VOID_KEY } from "@/lib/yearly-fallback";
import {
  FALLBACK_CHECK_DAYS,
  FALLBACK_MAX_DAYS,
  FALLBACK_PER_SET,
  FALLBACK_SHARE_MS,
  FALLBACK_SINCE_KEY,
  fallbackRefundedKey,
  fallbackShare,
  moveBackBody,
  settleFallbacks,
} from "@/lib/yearly-fallback-sweep";
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setProductYearly, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_fallback_sweep_only";
process.env.RESEND_API_KEY = "re_test_yearly_fallback_sweep_only";

const DAY = 86_400_000;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const nowSeconds = () => Math.floor(Date.now() / 1000);

const OWNER = "owner@example.com";
const ACCOUNT = "acct_1TestHarbor0001";
const SUB = "sub_Year00000001";
const YEAR = "in_Year00000001";
const MONTH = "in_Month0000001";
const PI = "pi_Month00000001";
const YPI = "pi_Year000000001";
let product = "";

type Obj = Record<string, unknown>;
const calls: { method: string; path: string; body: URLSearchParams; key: string | null; version: string | null }[] = [];
const mails: { to: string; subject: string; text: string }[] = [];
const state = {
  subs: new Map<string, Obj>(),
  invoices: new Map<string, Obj>(),
  charges: new Map<string, Obj>(),
  refunds: [] as Obj[],
  /** "METHOD /path" answered with Stripe's own failure. */
  fail: new Set<string>(),
  /** "METHOD /path" given no answer at all. */
  hang: new Set<string>(),
  /** "METHOD /path" refused for certain (a 400). */
  refuse: new Set<string>(),
  /** "METHOD /path" answered 403: the account no longer reachable. */
  deny: new Set<string>(),
  /** "METHOD /path" answered only after this many milliseconds, or when the caller gives up. */
  slow: new Map<string, number>(),
  /** A PaymentIntent's status, "succeeded" when not named. */
  intents: new Map<string, string>(),
};

const subscription = (onMonthly: boolean, extra: Obj = {}): Obj => ({
  id: SUB,
  object: "subscription",
  status: onMonthly ? "active" : "past_due",
  customer: "cus_Dana000001",
  pending_update: null,
  latest_invoice: onMonthly ? MONTH : YEAR,
  metadata: onMonthly ? { store: "harbor", product, every: "month", monthly_from: "year", monthly_replaced: YEAR } : { store: "harbor", product },
  items: {
    data: [
      {
        id: "si_Year0000001",
        quantity: 1,
        price: onMonthly
          ? { id: "price_Month00001", unit_amount: 2000, currency: "usd", metadata: { product }, recurring: { interval: "month", interval_count: 1 } }
          : { id: "price_Year00001", unit_amount: 20000, currency: "usd", metadata: { product }, recurring: { interval: "year", interval_count: 1 } },
      },
    ],
  },
  ...extra,
});
const yearEnd = () => nowSeconds() + 300 * 86_400;
const yearInvoice = (status: string): Obj => ({
  id: YEAR,
  status,
  created: nowSeconds() - 3 * 86_400,
  amount_paid: status === "paid" ? 20000 : 0,
  currency: "usd",
  parent: { subscription_details: { subscription: SUB } },
  lines: { data: [{ id: "il_Year0001", pricing: { price_details: { price: "price_Year00001" } }, period: { start: nowSeconds() - 3 * 86_400, end: yearEnd() } }] },
});
const monthInvoice = (status: string, extra: Obj = {}): Obj => ({
  id: MONTH,
  status,
  created: nowSeconds() - 86_400,
  amount_paid: status === "paid" ? 2000 : 0,
  currency: "usd",
  parent: { subscription_details: { subscription: SUB } },
  payments: { data: status === "paid" ? [{ id: "inpay_1", status: "paid", amount_paid: 2000, payment: { type: "payment_intent", payment_intent: PI } }] : [] },
  ...extra,
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    const sent = JSON.parse(String(init?.body)) as { to: string[] | string; subject: string; text: string };
    mails.push({ to: Array.isArray(sent.to) ? sent.to.join(",") : sent.to, subject: sent.subject, text: sent.text });
    return json({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  const headers = new Headers(init?.headers);
  calls.push({ method, path, body, key: headers.get("Idempotency-Key"), version: headers.get("Stripe-Version") });
  if (state.hang.has(`${method} ${path}`)) throw new TypeError("fetch failed");
  const wait = state.slow.get(`${method} ${path}`);
  if (wait) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }
  if (state.refuse.has(`${method} ${path}`)) return json({ error: { type: "invalid_request_error", code: "resource_missing", message: "The price specified is inactive. This field only accepts active prices." } }, 400);
  if (state.deny.has(`${method} ${path}`)) return json({ error: { type: "invalid_request_error", message: "The provided key does not have access to account" } }, 403);
  if (state.fail.has(`${method} ${path}`)) return json({ error: { type: "api_error", message: "down" } }, 500);
  const missing = () => json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, 404);

  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub && method === "GET") {
    const found = state.subs.get(sub[1]);
    if (!found) return missing();
    const latest = url.searchParams.getAll("expand[]").includes("latest_invoice") ? state.invoices.get(String(found.latest_invoice)) ?? found.latest_invoice : found.latest_invoice;
    return json({ ...found, latest_invoice: latest });
  }
  if (sub && method === "POST") {
    const found = state.subs.get(sub[1]);
    if (!found) return missing();
    const metadata = { ...(found.metadata as Record<string, string>) };
    for (const [k, value] of body) {
      const m = k.match(/^metadata\[(\w+)\]$/);
      if (m) {
        if (value) metadata[m[1]] = value;
        else delete metadata[m[1]];
      }
    }
    const price = body.get("items[0][price]");
    const items = price === "price_Year00001" ? (subscription(false).items as Obj) : found.items;
    const trialEnd = body.get("trial_end");
    const next = { ...found, metadata, items, ...(trialEnd ? { status: "trialing", trial_end: Number(trialEnd) } : {}) };
    state.subs.set(sub[1], next);
    return json(next);
  }
  const voiding = path.match(/^\/invoices\/(in_\w+)\/void$/);
  if (voiding && method === "POST") {
    const found = state.invoices.get(voiding[1]);
    if (!found) return missing();
    if (found.status !== "open" && found.status !== "uncollectible") return json({ error: { type: "invalid_request_error", message: "You can only void open invoices." } }, 400);
    found.status = "void";
    return json(found);
  }
  const invoice = path.match(/^\/invoices\/(in_\w+)$/);
  if (invoice && method === "GET") {
    const found = state.invoices.get(invoice[1]);
    if (!found) return missing();
    const { payments, ...rest } = found;
    const expand = url.searchParams.getAll("expand[]");
    if (!expand.some((e) => e.startsWith("payments"))) return json(rest);
    if (!expand.includes("payments.data.payment.payment_intent")) return json(found);
    const rows = ((payments as { data?: Obj[] } | undefined)?.data ?? []).map((row) => {
      const pay = row.payment as { payment_intent?: unknown } | undefined;
      const pi = typeof pay?.payment_intent === "string" ? pay.payment_intent : "";
      return pi ? { ...row, payment: { ...pay, payment_intent: { id: pi, status: state.intents.get(pi) ?? "succeeded" } } } : row;
    });
    return json({ ...found, payments: { ...(payments as Obj), data: rows } });
  }
  if (invoice && method === "POST") {
    const found = state.invoices.get(invoice[1]);
    if (!found) return missing();
    if (body.get("auto_advance")) found.auto_advance = body.get("auto_advance") === "true";
    return json(found);
  }
  const intent = path.match(/^\/payment_intents\/(pi_\w+)$/);
  if (intent && method === "GET") return json({ id: intent[1], latest_charge: state.charges.get(intent[1]) ?? null });
  if (path === "/refunds" && method === "GET") return json({ object: "list", data: state.refunds.filter((r) => r.payment_intent === url.searchParams.get("payment_intent")), has_more: false });
  if (path === "/refunds" && method === "POST") {
    const charge = state.charges.get(String(body.get("payment_intent")));
    const amount = Number(body.get("amount"));
    if (!charge || amount > Number(charge.amount) - Number(charge.amount_refunded)) return json({ error: { type: "invalid_request_error", code: "amount_too_large", message: "too much" } }, 400);
    charge.amount_refunded = Number(charge.amount_refunded) + amount;
    const made = { id: `re_${state.refunds.length + 1}`, amount, status: "succeeded", payment_intent: body.get("payment_intent"), reason: body.get("reason"), metadata: { fallback_refund: body.get("metadata[fallback_refund]") } };
    state.refunds.push(made);
    return json(made);
  }
  if (path === "/subscriptions" && method === "GET") return json({ object: "list", data: [], has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const posts = () => calls.filter((c) => c.method === "POST").map((c) => c.path);
const members = async (key: string) => (((await redisPipeline([["SMEMBERS", key]]))[0] as string[]) ?? []).sort();
const sweep = () => settleFallbacks(Date.now() + 20_000);
async function reset(sub: Obj | null, invoices: Obj[], charge?: Obj): Promise<void> {
  calls.length = 0;
  mails.length = 0;
  state.subs.clear();
  state.invoices.clear();
  state.charges.clear();
  state.refunds.length = 0;
  state.fail.clear();
  state.hang.clear();
  state.refuse.clear();
  state.deny.clear();
  state.slow.clear();
  state.intents.clear();
  shift = 0;
  // The year's own charge, clean unless a case says otherwise (paidYear, called after reset, replaces it).
  state.charges.set(YPI, { id: "ch_Year000000001", amount: 20000, amount_refunded: 0, disputed: false });
  if (sub) state.subs.set(SUB, sub);
  for (const invoice of invoices) state.invoices.set(String(invoice.id), invoice);
  if (charge) state.charges.set(PI, charge);
  await redisPipeline([["DEL", FALLBACK_VOID_KEY, FALLBACK_CHECK_KEY, FALLBACK_BOTH_KEY, FALLBACK_SINCE_KEY, fallbackRefundedKey(MONTH), `nl:yearly:fallback:denied:${ACCOUNT}`]]);
}
const put = (key: string, member: string) => redisPipeline([["SADD", key, member]]);
const paidCharge = (refunded = 0, disputed = false): Obj => ({ id: "ch_Month00000001", amount: 2000, amount_refunded: refunded, disputed });
/** The year paid with a payment of its own, its charge as given. */
const paidYear = (charge: Obj = { id: "ch_Year000000001", amount: 20000, amount_refunded: 0, disputed: false }): Obj => {
  state.charges.set(YPI, charge);
  return { ...yearInvoice("paid"), payments: { data: [{ id: "inpay_y", status: "paid", amount_paid: 20000, payment: { type: "payment_intent", payment_intent: YPI } }] } };
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("no product");
  product = made.product.id;
  await setProductLink(OWNER, product, "https://example.com/club");
  await setProductYearly(OWNER, product, { cents: 20000 });
  const harbor = (await storeForEmail(OWNER)) as Store;
  await redisPipeline([["HSET", FALLBACK_STORES_KEY, ACCOUNT, harbor.sid]]);

  part("VOID: the month was paid, voiding the year failed");
  await reset(subscription(true), [yearInvoice("open"), monthInvoice("paid")]);
  await put(FALLBACK_VOID_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  const first = await sweep();
  is("still open: voided, and taken off", [state.invoices.get(YEAR)?.status, posts(), await members(FALLBACK_VOID_KEY), first.settled], ["void", [`/invoices/${YEAR}/void`], [], 1]);
  is("at the pinned API version", calls.every((c) => c.version === FALLBACK_STRIPE_VERSION), true);
  calls.length = 0;
  await sweep();
  is("a second run does nothing more", calls.length, 0);

  await reset(subscription(true), [yearInvoice("void"), monthInvoice("paid")]);
  await put(FALLBACK_VOID_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is("voided already: only taken off", [posts(), await members(FALLBACK_VOID_KEY)], [[], []]);

  await reset(subscription(true), [yearInvoice("open"), monthInvoice("paid")]);
  state.fail.add(`GET /invoices/${YEAR}`);
  await put(FALLBACK_VOID_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is("Stripe's own failure: kept for tomorrow, nothing done", [posts(), await members(FALLBACK_VOID_KEY)], [[], [`${ACCOUNT}|${YEAR}|${MONTH}`]]);
  state.fail.clear();
  state.fail.add(`POST /invoices/${YEAR}/void`);
  await sweep();
  is("the void itself failed: kept for tomorrow", await members(FALLBACK_VOID_KEY), [`${ACCOUNT}|${YEAR}|${MONTH}`]);

  await reset(subscription(true), [yearInvoice("paid"), monthInvoice("paid")], paidCharge());
  await put(FALLBACK_VOID_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  const chained = await sweep();
  is(
    "paid meanwhile: the year is never voided, and its month is refunded the same run (BOTH)",
    [posts().includes(`/invoices/${YEAR}/void`), state.refunds.map((r) => r.amount), await members(FALLBACK_VOID_KEY), await members(FALLBACK_BOTH_KEY), chained.refunds],
    [false, [2000], [], [], 1],
  );

  await reset(null, []);
  await put(FALLBACK_VOID_KEY, `${ACCOUNT}|${YEAR}`);
  await put(FALLBACK_VOID_KEY, "garbage");
  await sweep();
  is("malformed members are taken off without a call", [calls.length, await members(FALLBACK_VOID_KEY)], [0, []]);

  part("CHECK: whether the move was made, read again");
  await reset(subscription(true), [yearInvoice("open"), monthInvoice("paid")]);
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  await sweep();
  is("moved with the month paid: the year is voided, and taken off", [state.invoices.get(YEAR)?.status, posts(), await members(FALLBACK_CHECK_KEY)], ["void", [`/invoices/${YEAR}/void`], []]);

  await reset(subscription(true), [yearInvoice("open"), monthInvoice("open")]);
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  await sweep();
  is("moved, the month still being paid: waits, nothing sent", [posts(), await members(FALLBACK_CHECK_KEY)], [[], [`${ACCOUNT}|${SUB}|${YEAR}`]]);
  shift = (FALLBACK_CHECK_DAYS - 2) * DAY;
  await sweep();
  is(`still waiting before ${FALLBACK_CHECK_DAYS} days`, [posts(), await members(FALLBACK_CHECK_KEY)], [[], [`${ACCOUNT}|${SUB}|${YEAR}`]]);
  shift = (FALLBACK_CHECK_DAYS + 1) * DAY;
  await sweep();
  is(
    `after ${FALLBACK_CHECK_DAYS} days: the year is voided (never retried, and no longer payable by hand), the month is what is owed`,
    [posts(), state.invoices.get(YEAR)?.status, state.invoices.get(YEAR)?.auto_advance ?? "unset", await members(FALLBACK_CHECK_KEY)],
    [[`/invoices/${YEAR}/void`], "void", "unset", []],
  );

  await reset(subscription(true), [yearInvoice("open"), monthInvoice("open")]);
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  await sweep();
  (state.invoices.get(YEAR) as Obj).status = "paid";
  (state.invoices.get(YEAR) as Obj).amount_paid = 20000;
  calls.length = 0;
  await sweep();
  is(
    "waiting, the year paid by hand on its page meanwhile: the month still owed is voided, the membership goes back to the year (BOTH)",
    [posts(), state.invoices.get(MONTH)?.status, await members(FALLBACK_CHECK_KEY), await members(FALLBACK_BOTH_KEY), state.refunds.length],
    [[`/invoices/${MONTH}/void`, `/subscriptions/${SUB}`], "void", [], [], 0],
  );

  await reset(subscription(true), [yearInvoice("open"), monthInvoice("open")]);
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  shift = (FALLBACK_CHECK_DAYS + 1) * DAY;
  state.fail.add(`POST /invoices/${YEAR}/void`);
  await sweep();
  is("the late void failed (a year payment still processing): kept for tomorrow", await members(FALLBACK_CHECK_KEY), [`${ACCOUNT}|${SUB}|${YEAR}`]);
  state.fail.clear();
  (state.invoices.get(YEAR) as Obj).status = "paid";
  await sweep();
  is("tomorrow the year reads paid: to BOTH, the month voided, never both kept", [state.invoices.get(MONTH)?.status, await members(FALLBACK_CHECK_KEY), await members(FALLBACK_BOTH_KEY)], ["void", [], []]);

  await reset(subscription(false, { pending_update: { expires_at: nowSeconds() + 3600 }, latest_invoice: MONTH }), [yearInvoice("open"), monthInvoice("open")]);
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  await sweep();
  is("still yearly with a pending update: waits for Stripe to let it expire", [posts(), await members(FALLBACK_CHECK_KEY)], [[], [`${ACCOUNT}|${SUB}|${YEAR}`]]);

  (state.invoices.get(YEAR) as Obj).status = "paid";
  await sweep();
  is(
    "the year paid by hand while the pending update still waits: its month is voided, so paying it can never move a paid year",
    [posts(), state.invoices.get(MONTH)?.status, await members(FALLBACK_CHECK_KEY)],
    [[`/invoices/${MONTH}/void`], "void", []],
  );

  await reset(subscription(false), [yearInvoice("open")]);
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  await sweep();
  is(
    "still yearly, no pending update: the move was never made, so the year is retried again as before",
    [posts(), calls.find((c) => c.method === "POST")?.body.get("auto_advance"), await members(FALLBACK_CHECK_KEY)],
    [[`/invoices/${YEAR}`], "true", []],
  );

  await reset(subscription(false, { status: "canceled" }), [yearInvoice("open")]);
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  await sweep();
  is("ended: the year is never turned back on", [posts(), await members(FALLBACK_CHECK_KEY)], [[], []]);

  await reset(subscription(true), [yearInvoice("paid"), monthInvoice("paid")], paidCharge());
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  await sweep();
  is("the year paid while moved and the month paid: the month is refunded (BOTH)", [state.refunds.map((r) => r.amount), await members(FALLBACK_CHECK_KEY), await members(FALLBACK_BOTH_KEY)], [[2000], [], []]);

  await reset(subscription(true), [yearInvoice("open"), monthInvoice("paid")]);
  state.hang.add(`GET /subscriptions/${SUB}`);
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  await sweep();
  is("no answer from Stripe: kept for tomorrow, nothing done", [posts(), await members(FALLBACK_CHECK_KEY)], [[], [`${ACCOUNT}|${SUB}|${YEAR}`]]);

  part("BOTH: the year and the month were paid");
  await reset(subscription(true), [yearInvoice("paid"), monthInvoice("paid")], paidCharge());
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  const both = await sweep();
  const back = calls.find((c) => c.method === "POST" && c.path === `/subscriptions/${SUB}`);
  is("in this order: back on the yearly price, then the month refunded", posts(), [`/subscriptions/${SUB}`, "/refunds"]);
  is(
    "back on the year's own price, nothing charged until the year paid ends, the move's marks taken off",
    [back?.body.toString(), back?.key],
    [moveBackBody("si_Year0000001", "price_Year00001", Number((yearInvoice("paid").lines as { data: { period: { end: number } }[] }).data[0].period.end), YEAR).toString(), `fallback-back:${YEAR}`],
  );
  const after = state.subs.get(SUB) as { metadata: Record<string, string>; items: { data: { price: { recurring: { interval: string } } }[] } };
  is("the membership reads as yearly again, the year named", [after.items.data[0].price.recurring.interval, after.metadata.yearly_paid, after.metadata.monthly_replaced ?? null], ["year", YEAR, null]);
  const refund = calls.find((c) => c.method === "POST" && c.path === "/refunds");
  is(
    "the month refunded in full, never more, as a duplicate, under a key of its own",
    [refund?.body.get("payment_intent"), refund?.body.get("amount"), refund?.body.get("reason"), refund?.body.get("metadata[fallback_refund]"), refund?.key, both.refunds],
    [PI, "2000", "duplicate", MONTH, `fallback-refund:${MONTH}:${PI}`, 1],
  );
  is(
    "the creator is told once, in English, from their own store's figure",
    [mails.length, mails[0]?.to, mails[0]?.subject, mails[0]?.text.includes("The month, $20, was refunded in full."), mails[0]?.text.includes(YEAR)],
    [1, OWNER, "A member's extra month was refunded for Supper Club", true, true],
  );
  is("taken off", await members(FALLBACK_BOTH_KEY), []);
  calls.length = 0;
  mails.length = 0;
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is("put back by mistake and run again: never a second refund, move or note", [posts(), mails.length, state.refunds.length, await members(FALLBACK_BOTH_KEY)], [[], 0, 1, []]);

  await reset(subscription(true), [yearInvoice("paid"), monthInvoice("paid")], paidCharge(500));
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is("part of the charge refunded already: only what is left on it", state.refunds.map((r) => r.amount), [1500]);

  await reset(subscription(true), [yearInvoice("paid"), monthInvoice("paid")], paidCharge(0, true));
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is(
    "a disputed month: never refunded, still moved back, and the creator told of the dispute (review, 4 November 2026)",
    [state.refunds.length, posts(), mails.length, mails[0]?.subject, await members(FALLBACK_BOTH_KEY)],
    [0, [`/subscriptions/${SUB}`], 1, "A member disputed an extra month they paid for Supper Club", []],
  );

  await reset(subscription(true), [yearInvoice("paid"), monthInvoice("paid")], paidCharge(2000));
  state.refunds.push({ id: "re_earlier", amount: 2000, status: "succeeded", payment_intent: PI, metadata: { fallback_refund: MONTH } });
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is("a refund of ours found made (no mark left): never a second, and its note is sent", [posts().includes("/refunds"), state.refunds.length, mails.length], [false, 1, 1]);

  await reset(subscription(true), [yearInvoice("paid"), monthInvoice("paid")], paidCharge());
  state.fail.add("POST /refunds");
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is("the refund failed: moved back, kept for tomorrow, no note", [posts(), state.refunds.length, mails.length, await members(FALLBACK_BOTH_KEY)], [[`/subscriptions/${SUB}`, "/refunds"], 0, 0, [`${ACCOUNT}|${YEAR}|${MONTH}`]]);
  state.fail.clear();
  calls.length = 0;
  await sweep();
  is("tomorrow: refunded once, not moved again, told once", [posts(), state.refunds.map((r) => r.amount), mails.length, await members(FALLBACK_BOTH_KEY)], [["/refunds"], [2000], 1, []]);

  await reset(subscription(true), [yearInvoice("paid"), monthInvoice("open")]);
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is("the month still owed: voided, never collected nor refunded, moved back", [posts(), state.invoices.get(MONTH)?.status, state.refunds.length, mails.length], [[`/invoices/${MONTH}/void`, `/subscriptions/${SUB}`], "void", 0, 0]);

  await reset(subscription(true), [yearInvoice("open"), monthInvoice("paid")], paidCharge());
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is("the year not paid after all: nothing undone", [posts(), await members(FALLBACK_BOTH_KEY)], [[], []]);

  await reset(subscription(true), [yearInvoice("paid"), monthInvoice("paid", { parent: { subscription_details: { subscription: "sub_Someone0001" } } })], paidCharge());
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is("invoices of two memberships: never refunded", [posts(), await members(FALLBACK_BOTH_KEY)], [[], []]);

  part("Found by the review of 4 November 2026 (rev26): each failed before its fix");
  await reset(subscription(true), [paidYear(), monthInvoice("paid")], paidCharge());
  state.refuse.add(`POST /subscriptions/${SUB}`);
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is(
    "the move back refused for certain (the yearly price archived): the month is refunded all the same, the entry settles, and the creator is told it is still monthly",
    [state.refunds.map((r) => r.amount), await members(FALLBACK_BOTH_KEY), mails.length, mails[0]?.text.includes("could not be moved back to the yearly price")],
    [[2000], [], 1, true],
  );

  await reset(subscription(true), [paidYear(), monthInvoice("paid", { amount_paid: 0, total: 2000, payments: { data: [] } })]);
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is(
    "a month paid from the member's credit balance (no payment of its own): settled, never kept, nothing refunded, the creator told",
    [await members(FALLBACK_BOTH_KEY), state.refunds.length, mails[0]?.subject],
    [[], 0, "A member paid an extra month that needs a look for Supper Club"],
  );
  await reset(subscription(true), [paidYear(), monthInvoice("paid", { payments: { data: [] } })]);
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is("a month marked paid outside Stripe: the same", [await members(FALLBACK_BOTH_KEY), state.refunds.length, mails.length], [[], 0, 1]);

  for (const [what, charge, extra] of [
    ["refunded on its charge", { id: "ch_Year000000001", amount: 20000, amount_refunded: 20000, refunded: true, disputed: false }, {}],
    ["disputed", { id: "ch_Year000000001", amount: 20000, amount_refunded: 0, disputed: true }, {}],
    ["refunded by a credit note", { id: "ch_Year000000001", amount: 20000, amount_refunded: 0, disputed: false }, { post_payment_credit_notes_amount: 20000 }],
  ] as const) {
    await reset(subscription(true), [], paidCharge());
    state.invoices.set(YEAR, { ...paidYear(charge as Obj), ...(extra as Obj) });
    state.invoices.set(MONTH, monthInvoice("paid"));
    await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
    await sweep();
    is(
      `the year ${what} since: never a free year (no move back), the month kept (no refund), the creator told, settled`,
      [posts(), state.refunds.length, mails[0]?.subject, await members(FALLBACK_BOTH_KEY)],
      [[], 0, "A member's yearly payment was refunded or disputed for Supper Club", []],
    );
  }

  await reset(subscription(true, { billing_mode: { type: "flexible" } }), [paidYear(), monthInvoice("paid")], paidCharge());
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is(
    "flexible billing mode (a trial keeps the billing date): no move back, the month refunded, the creator told it is still monthly",
    [posts(), state.refunds.map((r) => r.amount), mails[0]?.text.includes("could not be moved back to the yearly price")],
    [["/refunds"], [2000], true],
  );

  await reset(subscription(true), [yearInvoice("open"), monthInvoice("paid")]);
  state.invoices.set(YEAR, { ...yearInvoice("open"), payments: { data: [{ id: "inpay_y", status: "open", payment: { type: "payment_intent", payment_intent: YPI } }] } });
  state.intents.set(YPI, "processing");
  await put(FALLBACK_VOID_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  await sweep();
  is(
    "a year whose payment is still processing (a bank debit) is never voided: both wait",
    [posts(), state.invoices.get(YEAR)?.status, await members(FALLBACK_VOID_KEY), await members(FALLBACK_CHECK_KEY)],
    [[], "open", [`${ACCOUNT}|${YEAR}|${MONTH}`], [`${ACCOUNT}|${SUB}|${YEAR}`]],
  );
  await reset(subscription(true), [paidYear(), { ...monthInvoice("open"), payments: { data: [{ id: "inpay_m", status: "open", payment: { type: "payment_intent", payment_intent: PI } }] } }]);
  state.intents.set(PI, "processing");
  await put(FALLBACK_BOTH_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  is("nor a month whose payment is still processing: it waits, nothing moved", [posts(), await members(FALLBACK_BOTH_KEY)], [[], [`${ACCOUNT}|${YEAR}|${MONTH}`]]);

  await reset(subscription(true), [yearInvoice("open"), monthInvoice("paid")]);
  state.deny.add(`GET /invoices/${YEAR}`);
  await put(FALLBACK_VOID_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  const denied = await sweep();
  is(
    "an account Stripe refuses us (403): never taken for empty, kept, not read again that run, its creator told",
    [denied.denied, calls.length, await members(FALLBACK_VOID_KEY), await members(FALLBACK_CHECK_KEY), mails.map((m) => m.subject)],
    [1, 1, [`${ACCOUNT}|${YEAR}|${MONTH}`], [`${ACCOUNT}|${SUB}|${YEAR}`], ["We cannot reach your Stripe account"]],
  );
  mails.length = 0;
  shift = 2 * DAY;
  await sweep();
  is("told at most once a week", mails.length, 0);

  await reset(subscription(true), [yearInvoice("open"), monthInvoice("paid")]);
  state.fail.add(`GET /invoices/${YEAR}`);
  await put(FALLBACK_VOID_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await sweep();
  shift = (FALLBACK_MAX_DAYS - 1) * DAY;
  await sweep();
  is(`kept while Stripe fails, up to ${FALLBACK_MAX_DAYS} days`, [await members(FALLBACK_VOID_KEY), mails.length], [[`${ACCOUNT}|${YEAR}|${MONTH}`], 0]);
  shift = (FALLBACK_MAX_DAYS + 1) * DAY;
  // The store still pays its plan then, so its own email figure counts the note.
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const old = await sweep();
  is(
    `past ${FALLBACK_MAX_DAYS} days: taken off, its creator told what to look at`,
    [old.expired, await members(FALLBACK_VOID_KEY), mails[0]?.subject, mails[0]?.text.includes(YEAR)],
    [1, [], "A member's move to a monthly price needs a look", true],
  );

  part("Its own share of the daily job's time");
  const at = 1_000_000;
  is(
    `at most ${FALLBACK_SHARE_MS / 1000} seconds, never more than a third of what is left`,
    [fallbackShare(at + 45_000, at) - at, fallbackShare(at + 9_000, at) - at, fallbackShare(at - 5, at) - at],
    [FALLBACK_SHARE_MS, 3_000, 0],
  );
  await reset(subscription(true), [yearInvoice("open"), monthInvoice("paid")]);
  state.slow.set(`GET /invoices/${YEAR}`, 10_000);
  await put(FALLBACK_VOID_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  await put(FALLBACK_CHECK_KEY, `${ACCOUNT}|${SUB}|${YEAR}`);
  const began = Date.now();
  const short = await settleFallbacks(Date.now() + 1_500);
  is(
    "a Stripe call slower than the share is cut to it, and nothing new starts after: the emails after it keep their time",
    [Date.now() - began < 2_500, short.settled, await members(FALLBACK_VOID_KEY), await members(FALLBACK_CHECK_KEY)],
    [true, 0, [`${ACCOUNT}|${YEAR}|${MONTH}`], [`${ACCOUNT}|${SUB}|${YEAR}`]],
  );

  part("Bounded");
  await reset(subscription(true), [yearInvoice("open"), monthInvoice("paid")]);
  await put(FALLBACK_VOID_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  const late = await settleFallbacks(Date.now() - 1);
  is("past the deadline: nothing read, kept", [calls.length, late.settled, await members(FALLBACK_VOID_KEY)], [0, 0, [`${ACCOUNT}|${YEAR}|${MONTH}`]]);
  await reset(null, []);
  for (let i = 0; i < FALLBACK_PER_SET + 5; i += 1) await put(FALLBACK_VOID_KEY, `${ACCOUNT}|in_Gone${String(i).padStart(6, "0")}|${MONTH}`);
  const capped = await sweep();
  is(`at most ${FALLBACK_PER_SET} of a list a run`, [capped.settled, (await members(FALLBACK_VOID_KEY)).length], [FALLBACK_PER_SET, 5]);

  part("Run by the daily recovery job, first");
  await reset(subscription(true), [yearInvoice("open"), monthInvoice("paid")]);
  await put(FALLBACK_VOID_KEY, `${ACCOUNT}|${YEAR}|${MONTH}`);
  const job = await recoverFailedPayments(Date.now() + 20_000);
  is("the year is voided before anything else the job does", [job.settled, calls[0]?.path, state.invoices.get(YEAR)?.status], [1, `/invoices/${YEAR}`, "void"]);
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
