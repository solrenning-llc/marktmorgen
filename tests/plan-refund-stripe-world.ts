/**
 * A stand-in Stripe (and Resend) for the plan refund tests (tests/plan-refund-flow.test.ts,
 * tests/plan-refund-route.test.ts): keeps idempotency keys as Stripe does, records every call and every email.
 * Nothing real is reached.
 */
import { claimHandle, setAssistantPlan, setSubscription, storeForEmail } from "@/lib/store";
import { ENDING_KEY } from "@/lib/plan-refund-flow";
import { redisPipeline } from "@/lib/redis";

export { setAssistantPlan };
export const DAY = 86_400;
export const NOW = Date.UTC(2026, 11, 2) / 1000;

type Row = Record<string, unknown>;
export const world = {
  customers: new Map<string, string>(),
  subs: new Map<string, Row>(),
  invoices: [] as Row[],
  charges: [] as Row[],
  refunds: [] as Row[],
  replies: new Map<string, string>(),
  /** Every call, "METHOD path", in order. */
  calls: [] as string[],
  /** Stripe makes the refund, then the answer is lost. */
  loseAnswer: false,
  /** Refund writes answer 500 before doing anything. */
  refundsDown: false,
  /** Refund writes that still go through before they start answering 500 (null: no limit). */
  refundsLeft: null as number | null,
  /** Setting or taking back the stop answers 500 before doing anything. */
  stopDown: false,
  /** Ending a subscription answers 500 before doing anything. */
  endDown: false,
  /** Listing the platform's refunds answers 500. */
  listDown: false,
  /** Listing one charge's refunds answers 500. */
  chargeListDown: false,
  /** New refunds come back with this status. */
  refundStatus: "succeeded",
  /** Subscriptions whose updates answer 500. */
  postDownFor: new Set<string>(),
  slow: 0,
  /** Emails sent through the stand-in Resend. */
  emails: [] as { to: string; subject: string; text: string; key: string }[],
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fail = () => json({ error: { message: "down", type: "api_error" } }, 500);
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    world.emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text, key: new Headers(init?.headers).get("idempotency-key") ?? "" });
    return new Response(JSON.stringify({ id: `email_${world.emails.length}` }), { status: 200 });
  }
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  if (world.slow) await new Promise((r) => setTimeout(r, world.slow));
  const path = url.pathname.replace(/^\/v1/, "");
  const q = url.searchParams;
  world.calls.push(`${method} ${path}`);
  const page = (data: unknown[]) => json({ object: "list", data, has_more: false });
  const form = new URLSearchParams(String(init?.body ?? ""));
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = world.subs.get(sub[1]);
    if (!row) return json({ error: { message: "No such subscription", type: "invalid_request_error" } }, 404);
    if (method === "POST") {
      if (world.stopDown || world.postDownFor.has(sub[1])) return fail();
      if (row.status === "canceled") return json({ error: { message: "canceled", type: "invalid_request_error" } }, 400);
      row.cancel_at_period_end = form.get("cancel_at_period_end") === "true";
    }
    if (method === "DELETE") {
      if (world.endDown) return fail();
      if (row.status === "canceled") return json({ error: { message: "canceled", type: "invalid_request_error" } }, 400);
      row.status = "canceled";
      row.cancel_at_period_end = false;
    }
    const customer = String(row.customer);
    return json({ ...row, customer: q.getAll("expand[]").includes("customer") ? { id: customer, email: world.customers.get(customer), balance: 0 } : customer });
  }
  if (method === "POST" && path === "/refunds") {
    if (world.refundsDown || (world.refundsLeft !== null && world.refundsLeft-- <= 0)) return fail();
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    const kept = world.replies.get(key);
    if (kept) return new Response(kept, { status: 200, headers: { "content-type": "application/json" } });
    const charge = world.charges.find((c) => c.payment_intent === form.get("payment_intent"))!;
    const amount = Number(form.get("amount"));
    const refund = { id: `re_made${world.refunds.length + 1}x`, object: "refund", charge: charge.id, payment_intent: charge.payment_intent, amount, currency: "usd", status: world.refundStatus, created: NOW, metadata: { plan_refund: form.get("metadata[plan_refund]") } };
    world.refunds.push(refund);
    charge.amount_refunded = Number(charge.amount_refunded) + amount;
    world.replies.set(key, JSON.stringify(refund));
    if (world.loseAnswer) throw new TypeError("fetch failed");
    return json(refund);
  }
  if (method === "GET" && path === "/refunds") {
    if (q.get("charge")) return world.chargeListDown ? fail() : page(world.refunds.filter((r) => r.charge === q.get("charge")));
    if (world.listDown) return fail();
    const since = Number(q.get("created[gte]"));
    const until = Number(q.get("created[lte]") ?? Infinity);
    return page(world.refunds.filter((r) => Number(r.created) >= since && Number(r.created) <= until).reverse());
  }
  const voiding = path.match(/^\/invoices\/(in_\w+)\/void$/);
  if (voiding && method === "POST") {
    const row = world.invoices.find((i) => i.id === voiding[1])!;
    row.status = "void";
    return json(row);
  }
  const invoice = path.match(/^\/invoices\/(in_\w+)$/);
  if (invoice && method === "DELETE") {
    world.invoices = world.invoices.filter((i) => i.id !== invoice[1]);
    return json({ id: invoice[1], deleted: true });
  }
  if (method !== "GET") return json({ error: { message: `no stand-in for ${method} ${path}` } }, 400);
  if (path === "/invoices") return page(world.invoices.filter((i) => i.subscription === q.get("subscription") && i.status === q.get("status")));
  if (path === "/charges") return page(world.charges.filter((c) => c.customer === q.get("customer")));
  const charge = path.match(/^\/charges\/(ch_\w+)$/);
  if (charge) return json(world.charges.find((c) => c.id === charge[1]));
  if (path === "/charges/search" || path === "/customers/search") return page([]);
  if (path === "/disputes") return page([]);
  return json({ error: { message: `no stand-in for ${path}` } }, 404);
}) as typeof fetch;

export let n = 0;
export async function paidShop(o: { at?: number; stopSet?: boolean } = {}) {
  n += 1;
  const handle = `flow${n}`;
  const email = `${handle}@example.com`;
  const customer = `cus_${handle}0001`;
  const subId = `sub_${handle}0001`;
  await claimHandle(email, handle, `Flow ${n}`, "");
  await setSubscription(email, { customerId: customer, subscriptionId: subId, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  world.customers.set(customer, email);
  world.subs.set(subId, { id: subId, customer, status: "active", cancel_at_period_end: o.stopSet ?? false, metadata: { store: handle } });
  const at = o.at ?? NOW - 3 * DAY;
  const id = `ch_${handle}x1`;
  world.invoices.push({ id: `in_${handle}x1`, subscription: subId, status: "paid", created: at, total: 6_900, tax: null, billing_reason: "subscription_create", charge: id, status_transitions: { paid_at: at }, lines: { data: [{ type: "subscription", period: { start: at }, price: { unit_amount: 6_900, currency: "usd", recurring: { interval: "month" } } }] } });
  world.invoices.push({ id: `in_${handle}open`, subscription: subId, status: "open" }, { id: `in_${handle}draft`, subscription: subId, status: "draft" });
  world.charges.push({ id, customer, invoice: `in_${handle}x1`, payment_intent: `pi_${handle}x1`, status: "succeeded", paid: true, currency: "usd", created: at, amount_captured: 6_900, amount_refunded: 0, disputed: false, payment_method_details: { card: { fingerprint: `fp${handle}` } }, balance_transaction: { fee: 230, currency: "usd" } });
  const store = async () => (await storeForEmail(email))!;
  /** Another paid plan invoice and its charge (a renewal by default), `at` seconds. */
  const addPayment = (paidAt: number, reason = "subscription_cycle") => {
    const k = world.charges.length + 1;
    const cid = `ch_${handle}y${k}`;
    world.invoices.push({ id: `in_${handle}y${k}`, subscription: subId, status: "paid", created: paidAt, total: 6_900, tax: null, billing_reason: reason, charge: cid, status_transitions: { paid_at: paidAt }, lines: { data: [{ type: "subscription", period: { start: paidAt }, price: { unit_amount: 6_900, currency: "usd", recurring: { interval: "month" } } }] } });
    world.charges.push({ id: cid, customer, invoice: `in_${handle}y${k}`, payment_intent: `pi_${handle}y${k}`, status: "succeeded", paid: true, currency: "usd", created: paidAt, amount_captured: 6_900, amount_refunded: 0, disputed: false, payment_method_details: { card: { fingerprint: `fp${handle}` } }, balance_transaction: { fee: 230, currency: "usd" } });
    return cid;
  };
  return {
    subId,
    store,
    addPayment,
    allRefunds: () => world.refunds.filter((r) => world.charges.some((c) => c.id === r.charge && c.customer === customer)),
    sub: () => world.subs.get(subId)!,
    refunds: () => world.refunds.filter((r) => r.charge === id),
    invoices: () => world.invoices.filter((i) => i.subscription === subId && i.status !== "paid").map((i) => `${i.id}:${i.status}`),
    note: async () => (await redisPipeline([["HGET", ENDING_KEY, (await store()).sid]]))[0],
  };
}
