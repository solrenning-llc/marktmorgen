/**
 * The plan guarantee reads a charge's dispute only from a row of that charge (rule 30; Claude 5 on #3133): a
 * /disputes?charge= reply whose row belongs to another charge, or names no charge, is unknown, never "won" for this
 * payment. Otherwise a won dispute elsewhere makes the 30-day guarantee payable on a charge whose own dispute is
 * lost, and lib/plan-refund-write.ts would give the money back twice. Against a stand-in Stripe; nothing real is
 * reached and nothing is written to Stripe.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { readPlanRefund } from "@/lib/plan-refund";

const DAY = 86_400;
const NOW = Date.UTC(2026, 11, 2) / 1000;

type Charge = Record<string, unknown> & { id: string; customer: string; created: number };
const world = {
  customers: new Map<string, string>(),
  subs: new Map<string, Record<string, unknown>>(),
  invoices: [] as Record<string, unknown>[],
  charges: [] as Charge[],
  disputes: [] as Record<string, unknown>[],
  /** One exact /disputes page, whatever charge is asked for: another charge's row, or one with no charge. */
  disputesReply: undefined as Record<string, unknown>[] | undefined,
  /** Every request answers 500. */
  down: false,
  /** The customer's charge list says there is more. */
  moreCharges: false,
  /** An exact stand-in answer for the paid-invoice list; undefined keeps the normal list. */
  invoiceListReply: undefined as unknown | undefined,
  /** One exact list/search response used to prove that partial history rows stay unknown. */
  historyReply: null as { path: "/charges" | "/charges/search" | "/customers/search"; customer?: string; data: unknown[] } | null,
  /** An exact stand-in answer for GET /invoices/<id>, by id: another invoice's, or one with no id (rule 30). */
  invoiceByIdReply: new Map<string, unknown>(),
  /** A customer's Stripe balance (negative: a credit), 0 when not set. */
  balance: new Map<string, number>(),
  calls: 0,
  writes: 0,
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  world.calls += 1;
  if (method !== "GET") {
    world.writes += 1;
    return json({ error: { message: "no writes here" } }, 400);
  }
  if (world.down) return json({ error: { message: "down" } }, 500);
  const path = url.pathname.replace(/^\/v1/, "");
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
    if (world.invoiceByIdReply.has(invoice[1])) return json(world.invoiceByIdReply.get(invoice[1]));
    const row = world.invoices.find((i) => i.id === invoice[1]);
    if (!row) return json({ error: { message: "No such invoice" } }, 404);
    const sub = world.subs.get(String(row.subscription)) ?? { id: row.subscription, metadata: { store: "another-store" } };
    return json({ ...row, subscription: q.getAll("expand[]").includes("subscription") ? sub : row.subscription });
  }
  const charge = path.match(/^\/charges\/(ch_\w+)$/);
  if (charge) {
    const row = world.charges.find((c) => c.id === charge[1]);
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
  if (path === "/disputes") return page(world.disputesReply ?? world.disputes.filter((d) => d.charge === q.get("charge")));
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
  world.subs.set(subscriptionId, { id: subscriptionId, status: "active", customer, metadata: { store: handle, tier: "creator" }, items: { data: [{ price: { unit_amount: cycle === "year" ? 69_000 : 6_900, recurring: { interval: cycle } } }] } });
  return { handle, email, customer, subscriptionId, read: async () => readPlanRefund((await storeForEmail(email))!, NOW) };
}

/** One paid plan invoice and its charge. */
function pay(s: { customer: string; subscriptionId: string; handle: string }, o: { at: number; cycle?: "month" | "year"; amount?: number; total?: number; tax?: number; refunded?: number; fee?: number; feeCurrency?: string; reason?: string; card?: string; disputed?: boolean; subscription?: string }) {
  const k = world.charges.length + 1;
  const id = `ch_${s.handle}x${k}`;
  const inv = `in_${s.handle}x${k}`;
  const cycle = o.cycle ?? "month";
  const amount = o.amount ?? (cycle === "year" ? 69_000 : 6_900);
  world.invoices.push({ id: inv, subscription: o.subscription ?? s.subscriptionId, status: "paid", created: o.at, total: o.total ?? amount, tax: o.tax ?? null, billing_reason: o.reason ?? "subscription_create", charge: id, status_transitions: { paid_at: o.at }, lines: { data: [{ type: "subscription", period: { start: o.at }, price: { unit_amount: cycle === "year" ? 69_000 : 6_900, currency: "usd", recurring: { interval: cycle } } }] } });
  world.charges.push({ id, customer: s.customer, invoice: inv, payment_intent: `pi_${s.handle}x${k}`, status: "succeeded", paid: true, currency: "usd", created: o.at, amount_captured: amount, amount_refunded: o.refunded ?? 0, disputed: o.disputed ?? false, payment_method_details: { card: { fingerprint: o.card ?? `fp${s.handle}` } }, balance_transaction: { fee: o.fee ?? 230, currency: o.feeCurrency ?? "usd" } });
  return { id, inv, pi: `pi_${s.handle}x${k}` };
}
async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";

  part("A dispute row of another charge, or of none, is unknown, never this payment's dispute");
  const a = await shop();
  pay(a, { at: NOW - 3 * DAY, disputed: true });
  world.disputesReply = [{ id: "du_other", charge: "ch_someoneelse0001", status: "won", amount: 6_900 }];
  is("a won dispute of another charge: unknown", (await a.read()).refund, { kind: "unknown", reason: "unreadable" });
  world.disputesReply = [{ id: "du_nocharge", status: "won", amount: 6_900 }];
  is("a won dispute that names no charge: unknown", (await a.read()).refund, { kind: "unknown", reason: "unreadable" });
  world.disputesReply = [{ id: "du_expanded", charge: { id: "ch_someoneelse0002" }, status: "won", amount: 6_900 }];
  is("another charge, expanded: unknown", (await a.read()).refund, { kind: "unknown", reason: "unreadable" });
  world.disputesReply = undefined;

  part("Controls: this charge's own row decides as before");
  const b = await shop();
  const bPaid = pay(b, { at: NOW - 3 * DAY, disputed: true });
  world.disputes.push({ id: "du_bwon", charge: bPaid.id, status: "won", amount: 6_900 });
  is("its own dispute won: the guarantee applies", (await b.read()).refund, { kind: "guarantee", cents: 6_900 });
  const c = await shop();
  const cPaid = pay(c, { at: NOW - 3 * DAY, disputed: true });
  world.disputesReply = [{ id: "du_cexp", charge: { id: cPaid.id }, status: "won", amount: 6_900 }];
  is("its own dispute, charge expanded: the guarantee applies", (await c.read()).refund, { kind: "guarantee", cents: 6_900 });
  world.disputesReply = undefined;
  const d = await shop();
  const dPaid = pay(d, { at: NOW - 3 * DAY, disputed: true });
  world.disputes.push({ id: "du_dopen", charge: dPaid.id, status: "needs_response", amount: 6_900 });
  is("its own dispute open: no refund now", (await d.read()).refund, { kind: "none", reason: "dispute_open" });
  is("nothing was written to Stripe", world.writes, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
