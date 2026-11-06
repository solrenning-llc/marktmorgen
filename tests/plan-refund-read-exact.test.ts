/**
 * Rule 24 on judge() in lib/plan-refund.ts: an invoice line, an invoice or a
 * charge read from Stripe in a partial shape is "unknown" (support), never a
 * plan refund read from something else, never a silent "none" (which the
 * write turns into "not owed") and never an amount. Synthetic data against a
 * stand-in Stripe; nothing real is reached.
 *
 * What fails here:
 *   - a line whose interval is not exactly "year" or "month" judged by today's
 *     subscription instead (a yearly payment read as monthly: the months not
 *     started refused as "outside_window", a yearly switch as "switch_charge");
 *   - an invoice without `tax` read as no tax (the refund too high);
 *   - a charge without `status`/`paid` read as unpaid, without `disputed` read
 *     as not disputed, without `currency` given back (a refund made, then
 *     reported failed), a dispute without a status read as open;
 *   - any change to the healthy amounts.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { readPlanRefund } from "@/lib/plan-refund";
import { refundPlanPayment } from "@/lib/plan-refund-write";

const DAY = 86_400;
const NOW = Date.UTC(2026, 11, 2) / 1000;

type Charge = Record<string, unknown> & { id: string; customer: string; created: number };
const world = {
  customers: new Map<string, string>(),
  subs: new Map<string, Record<string, unknown>>(),
  invoices: [] as Record<string, unknown>[],
  charges: [] as Charge[],
  disputes: [] as Record<string, unknown>[],
  /** Every request answers 500. */
  down: false,
  /** The customer's charge list says there is more. */
  moreCharges: false,
  /** An exact stand-in answer for the paid-invoice list; undefined keeps the normal list. */
  invoiceListReply: undefined as unknown | undefined,
  /** One exact list/search response used to prove that partial history rows stay unknown. */
  historyReply: null as { path: "/charges" | "/charges/search" | "/customers/search"; customer?: string; data: unknown[] } | null,
  /** A customer's Stripe balance (negative: a credit), 0 when not set. */
  balance: new Map<string, number>(),
  /** A charge's own read (GET /v1/charges/{id}) in a partial shape; the customer's charge list keeps the whole row. */
  singleCharge: new Map<string, Record<string, unknown>>(),
  refundsMade: 0,
  calls: 0,
  writes: 0,
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  world.calls += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/refunds") {
    world.writes += 1;
    world.refundsMade += 1;
    const form = new URLSearchParams(String(init?.body ?? ""));
    return json({ id: `re_made${world.refundsMade}x`, object: "refund", amount: Number(form.get("amount")), currency: "usd", status: "succeeded", payment_intent: form.get("payment_intent") });
  }
  if (method === "GET" && path === "/refunds") return json({ object: "list", data: [], has_more: false, url: "/v1/refunds" });
  if (method !== "GET") {
    world.writes += 1;
    return json({ error: { message: "no writes here" } }, 400);
  }
  if (world.down) return json({ error: { message: "down" } }, 500);
  const q = url.searchParams;
  const page = (data: unknown[], more = false) => json({ object: "list", data, has_more: more });
  const searchPage = (data: unknown[]) => json({ object: "search_result", data, has_more: false, next_page: null });
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = world.subs.get(sub[1]);
    if (!row) return json({ error: { message: "No such subscription" } }, 404);
    const customer = String(row.customer);
    return json({ ...row, customer: q.getAll("expand[]").includes("customer") ? { id: customer, email: world.customers.get(customer) ?? "", balance: world.balance.get(customer) ?? 0 } : customer });
  }
  if (path === "/invoices") {
    if (world.invoiceListReply !== undefined) return json(world.invoiceListReply);
    return page(world.invoices.filter((i) => i.subscription === q.get("subscription") && i.status === q.get("status")).sort((a, b) => Number(b.created) - Number(a.created)));
  }
  if (path === "/charges") {
    if (world.historyReply?.path === path && (!world.historyReply.customer || world.historyReply.customer === q.get("customer"))) {
      return page(world.historyReply.data);
    }
    const lt = Number(q.get("created[lt]") ?? Infinity);
    const rows = world.charges.filter((c) => c.customer === q.get("customer") && c.created < lt).sort((a, b) => b.created - a.created).map((c) => ({ ...c, balance_transaction: "txn_unexpanded" })).slice(0, Number(q.get("limit") ?? 10));
    return page(rows, world.moreCharges);
  }
  const invoice = path.match(/^\/invoices\/(in_\w+)$/);
  if (invoice) {
    const row = world.invoices.find((i) => i.id === invoice[1]);
    if (!row) return json({ error: { message: "No such invoice" } }, 404);
    const sub = world.subs.get(String(row.subscription)) ?? { id: row.subscription, metadata: { store: "another-store" } };
    return json({ ...row, subscription: q.getAll("expand[]").includes("subscription") ? sub : row.subscription });
  }
  const charge = path.match(/^\/charges\/(ch_\w+)$/);
  if (charge) {
    const row = world.singleCharge.get(charge[1]) ?? world.charges.find((c) => c.id === charge[1]);
    return row ? json(row) : json({ error: { message: "No such charge" } }, 404);
  }
  if (path === "/charges/search") {
    if (world.historyReply?.path === path) return searchPage(world.historyReply.data);
    const query = q.get("query") ?? "";
    const fp = query.match(/fingerprint:"(\w+)"/)?.[1];
    const lt = Number(query.match(/created<(\d+)/)?.[1] ?? Infinity);
    return searchPage(world.charges.filter((c) => (c.payment_method_details as { card: { fingerprint: string } }).card.fingerprint === fp && c.status === "succeeded" && c.created < lt));
  }
  if (path === "/customers/search") {
    if (world.historyReply?.path === path) return searchPage(world.historyReply.data);
    const email = (q.get("query") ?? "").match(/email:"([^"]+)"/)?.[1];
    return searchPage([...world.customers].filter(([, e]) => e === email).map(([id, e]) => ({ id, email: e })));
  }
  if (path === "/disputes") return page(world.disputes.filter((d) => d.charge === q.get("charge")));
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

let n = 0;
/** A store with a plan subscription on one customer. */
async function shop(cycle: "month" | "year" = "month") {
  n += 1;
  const handle = `shop${n}`;
  const email = `${handle}@example.com`;
  const customer = `cus_${handle}0001`;
  const subscriptionId = `sub_${handle}0001`;
  await claimHandle(email, handle, `Shop ${n}`, "");
  await setSubscription(email, { customerId: customer, subscriptionId, active: true, tier: "creator", cycle, trialEnds: 0 });
  world.customers.set(customer, email);
  return { handle, email, customer, subscriptionId, read: async () => readPlanRefund((await storeForEmail(email))!, NOW) };
}

type SubShape = "healthy" | "no_items" | "empty_items" | "no_recurring" | "no_price" | "now_monthly";
function setSub(s: { subscriptionId: string; customer: string; handle: string }, shape: SubShape) {
  const base: Record<string, unknown> = { id: s.subscriptionId, status: "active", customer: s.customer, metadata: { store: s.handle, tier: "creator" }, cancel_at: null, cancel_at_period_end: false };
  const yearItem = { price: { unit_amount: 69_000, recurring: { interval: "year" } } };
  if (shape === "healthy") base.items = { data: [yearItem] };
  if (shape === "empty_items") base.items = { data: [] };
  if (shape === "no_recurring") base.items = { data: [{ price: { unit_amount: 69_000 } }] };
  if (shape === "no_price") base.items = { data: [{}] };
  if (shape === "now_monthly") base.items = { data: [{ price: { unit_amount: 6_900, recurring: { interval: "month" } } }] };
  world.subs.set(s.subscriptionId, base);
}

type LineShape = "healthy" | "no_recurring" | "no_price" | "no_sub_line" | "odd_interval";
/** A first yearly payment outside the window (Aug 15), its invoice line in the given shape. */
function payYear(s: { customer: string; subscriptionId: string; handle: string }, shape: LineShape, o: { at: number; reason?: string; tax?: number | null | "absent"; amount?: number }) {
  const k = world.charges.length + 1;
  const id = `ch_${s.handle}x${k}`;
  const inv = `in_${s.handle}x${k}`;
  const amount = o.amount ?? 69_000;
  const price: Record<string, unknown> = { unit_amount: 69_000, currency: "usd", recurring: { interval: "year" } };
  if (shape === "no_recurring") delete price.recurring;
  if (shape === "odd_interval") price.recurring = { interval: "week" };
  const line: Record<string, unknown> = { type: "subscription", period: { start: o.at }, price };
  if (shape === "no_price") delete line.price;
  if (shape === "no_sub_line") line.type = "invoiceitem";
  const invoice: Record<string, unknown> = { id: inv, subscription: s.subscriptionId, status: "paid", created: o.at, total: amount, billing_reason: o.reason ?? "subscription_create", charge: id, status_transitions: { paid_at: o.at }, lines: { data: [line] } };
  if (o.tax !== "absent") invoice.tax = o.tax ?? null;
  world.invoices.push(invoice);
  world.charges.push({ id, customer: s.customer, invoice: inv, payment_intent: `pi_${s.handle}x${k}`, status: "succeeded", paid: true, currency: "usd", created: o.at, amount_captured: amount, amount_refunded: 0, disputed: false, payment_method_details: { card: { fingerprint: `fp${s.handle}` } }, balance_transaction: { fee: 2_031, currency: "usd" } });
}

const START = Date.UTC(2026, 7, 15) / 1000;
/** A monthly first payment inside the 30 days, its charge whole. */
function payMonth(s: { customer: string; subscriptionId: string; handle: string }, o: { at: number; disputed?: boolean; line?: LineShape }) {
  const k = world.charges.length + 1;
  const id = `ch_${s.handle}x${k}`;
  const inv = `in_${s.handle}x${k}`;
  const price: Record<string, unknown> = { unit_amount: 6_900, currency: "usd", recurring: { interval: "month" } };
  if (o.line === "no_recurring") delete price.recurring;
  world.invoices.push({ id: inv, subscription: s.subscriptionId, status: "paid", created: o.at, total: 6_900, tax: null, billing_reason: "subscription_create", charge: id, status_transitions: { paid_at: o.at }, lines: { data: [{ type: "subscription", period: { start: o.at }, price }] } });
  world.charges.push({ id, customer: s.customer, invoice: inv, payment_intent: `pi_${s.handle}x${k}`, status: "succeeded", paid: true, currency: "usd", created: o.at, amount_captured: 6_900, amount_refunded: 0, disputed: o.disputed ?? false, payment_method_details: { card: { fingerprint: `fp${s.handle}` } }, balance_transaction: { fee: 230, currency: "usd" } });
  return id;
}

/** The charge's own read in a partial shape (the customer's charge list keeps the whole row). */
function partialCharge(id: string, change: (c: Record<string, unknown>) => void) {
  const row = { ...world.charges.find((c) => c.id === id)! };
  change(row);
  world.singleCharge.set(id, row);
}

const UNREADABLE = { kind: "unknown", reason: "unreadable" };

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";

  part("Healthy controls: the amounts do not move");
  const hy = await shop("year"); setSub(hy, "healthy"); payYear(hy, "healthy", { at: START });
  is("a yearly first payment outside the window: its months not started", (await hy.read()).refund, { kind: "unstarted_months", cents: 39_369, monthsKept: 4 });
  const hu = await shop("year"); setSub(hu, "healthy"); payYear(hu, "healthy", { at: START, reason: "subscription_update" });
  is("a yearly switch charge: to support, as before", (await hu.read()).refund, { kind: "unknown", reason: "switch_yearly" });
  const hm = await shop(); setSub(hm, "now_monthly"); payMonth(hm, { at: NOW - 3 * DAY });
  is("a monthly first payment inside the 30 days: the guarantee", (await hm.read()).refund, { kind: "guarantee", cents: 6_900 });
  const tx = await shop("year"); setSub(tx, "healthy"); payYear(tx, "healthy", { at: START, amount: 87_630, tax: 18_630 });
  is("a yearly payment with its tax: the tax given back in proportion", (await tx.read()).refund, { kind: "unstarted_months", cents: 50_547, monthsKept: 4 });
  const tn = await shop("year"); setSub(tn, "healthy"); payYear(tn, "healthy", { at: START, tax: null });
  is("an invoice whose tax is null (no tax): as before", (await tn.read()).refund, { kind: "unstarted_months", cents: 39_369, monthsKept: 4 });

  part("A line without its exact interval is unknown, never today's subscription");
  const lines: LineShape[] = ["no_recurring", "no_price", "no_sub_line", "odd_interval"];
  const subs: SubShape[] = ["healthy", "no_items", "empty_items", "no_recurring", "no_price", "now_monthly"];
  let shapes = 0;
  let wrong: string[] = [];
  for (const reason of ["subscription_create", "subscription_update"]) {
    for (const ls of lines) for (const ss of subs) {
      const s = await shop("year"); setSub(s, ss); payYear(s, ls, { at: START, reason });
      const got = (await s.read()).refund;
      shapes += 1;
      if (JSON.stringify(got) !== JSON.stringify(UNREADABLE)) wrong.push(`${reason} line=${ls} sub=${ss}: ${JSON.stringify(got)}`);
    }
  }
  is(`every one of ${shapes} partial line shapes, either billing reason: unknown`, wrong, []);
  const gm = await shop(); setSub(gm, "now_monthly"); payMonth(gm, { at: NOW - 3 * DAY, line: "no_recurring" });
  const gr = (await gm.read()).refund;
  is("a line without `recurring`, a monthly subscription, inside the 30 days: unknown (support), never none", gr, UNREADABLE);
  const ym = await shop("year"); setSub(ym, "now_monthly"); payYear(ym, "no_recurring", { at: START });
  is("a yearly payment's line without `recurring`, the subscription monthly today: unknown, never outside_window", (await ym.read()).refund, UNREADABLE);

  part("An invoice without `tax` is unknown, never no tax");
  wrong = [];
  for (const tax of ["absent", "18630", {}, true] as const) {
    const s = await shop("year"); setSub(s, "healthy");
    payYear(s, "healthy", { at: START, amount: 87_630, tax: tax === "absent" ? "absent" : (tax as unknown as number) });
    const got = (await s.read()).refund;
    if (JSON.stringify(got) !== JSON.stringify(UNREADABLE)) wrong.push(`tax=${JSON.stringify(tax)}: ${JSON.stringify(got)}`);
  }
  is("tax absent, a string, an object, a boolean: unknown, never an amount", wrong, []);

  part("A charge read in part is unknown");
  const changes: [string, (c: Record<string, unknown>) => void][] = [
    ["without status", (c) => { delete c.status; }],
    ["with a status Stripe does not have", (c) => { c.status = "processing"; }],
    ["without paid", (c) => { delete c.paid; }],
    ["without disputed", (c) => { delete c.disputed; }],
    ["with disputed not a boolean", (c) => { c.disputed = "false"; }],
    ["without currency", (c) => { delete c.currency; }],
    ["with an empty currency", (c) => { c.currency = ""; }],
  ];
  for (const [label, change] of changes) {
    const g = await shop(); setSub(g, "now_monthly"); partialCharge(payMonth(g, { at: NOW - 3 * DAY }), change);
    is(`inside the 30 days, the charge ${label}: unknown`, (await g.read()).refund, UNREADABLE);
    const y = await shop("year"); setSub(y, "healthy"); payYear(y, "healthy", { at: START });
    partialCharge(world.charges[world.charges.length - 1].id, change);
    is(`a yearly payment, the charge ${label}: unknown`, (await y.read()).refund, UNREADABLE);
  }

  part("A dispute without a status is unknown, never open");
  for (const [status, want] of [["won", { kind: "guarantee", cents: 6_900 }], ["lost", { kind: "none", reason: "dispute_returned" }], [7, UNREADABLE], [undefined, UNREADABLE], [null, UNREADABLE]] as const) {
    const d = await shop(); setSub(d, "now_monthly");
    const id = payMonth(d, { at: NOW - 3 * DAY, disputed: true });
    world.disputes.push({ id: `dp_${d.handle}`, charge: id, status, amount: 6_900 });
    is(`a dispute with status ${JSON.stringify(status)}`, (await d.read()).refund, want);
  }

  part("Reading wrote nothing");
  is("no write to Stripe while reading", world.writes, 0);

  part("The write: a charge without its currency makes no refund");
  const w = await shop(); setSub(w, "now_monthly"); partialCharge(payMonth(w, { at: NOW - 3 * DAY }), (c) => { delete c.currency; });
  const made = await refundPlanPayment((await storeForEmail(w.email))!, NOW);
  is("the answer is unknown (support)", made, { ok: false, reason: "unknown" });
  is("no refund was made", world.refundsMade, 0);
  const ok = await shop(); setSub(ok, "now_monthly"); payMonth(ok, { at: NOW - 3 * DAY });
  const was = world.refundsMade;
  const healthy = await refundPlanPayment((await storeForEmail(ok.email))!, NOW);
  is("control: a whole charge is refunded once, its amount whole", [healthy.ok, healthy.ok && healthy.cents, world.refundsMade - was], [true, 6_900, 1]);

  done();
}

void main();
