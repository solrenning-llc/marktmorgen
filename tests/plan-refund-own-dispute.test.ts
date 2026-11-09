/**
 * A plan payment's dispute is read only from Stripe's reply for that payment's own charge (rule 30; review of #3133,
 * Claude 5): lib/plan-refund.ts asked GET /disputes?charge=<id> and took disputes[0].status without checking that the
 * row was that charge's. A "won" row of another charge made the guarantee payable on a charge whose own dispute was
 * lost (the bank already gave the money back), and lib/plan-refund-write.ts then asked Stripe for a refund on it: the
 * same money out twice, held back only by Stripe's own refusal. Against a stand-in Stripe; nothing real is reached.
 *
 * What fails here:
 *   - a dispute row of another charge read as this charge's dispute (a guarantee, a refund written);
 *   - a dispute list that says there is more, read as complete;
 *   - a dispute status that is not one of Stripe's, or a `disputed` flag not in its shape, read as no dispute;
 *   - the guarantee no longer given when the charge's own dispute was won (the fix must not close too much).
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { readPlanRefund } from "@/lib/plan-refund";
import { refundPlanPayment } from "@/lib/plan-refund-write";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
const world = {
  customers: new Map<string, string>(),
  subs: new Map<string, Row>(),
  invoices: [] as Row[],
  charges: [] as Row[],
  /** The exact reply to GET /disputes, by the charge asked for. */
  disputes: new Map<string, unknown>(),
  /** Every POST /refunds asked for. */
  refundWrites: [] as string[],
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  const q = url.searchParams;
  const page = (data: unknown[]) => json({ object: "list", data, has_more: false });
  const searchPage = (data: unknown[]) => json({ object: "search_result", data, has_more: false, next_page: null });
  if (method === "POST" && path === "/refunds") {
    const form = new URLSearchParams(String(init?.body));
    world.refundWrites.push(String(form.get("payment_intent")));
    const charge = world.charges.find((c) => c.payment_intent === form.get("payment_intent"))!;
    const amount = Number(form.get("amount"));
    return json({ id: `re_made${world.refundWrites.length}x`, object: "refund", charge: charge.id, payment_intent: charge.payment_intent, amount, currency: "usd", status: "succeeded" });
  }
  if (method !== "GET") return json({ error: { message: `no stand-in for ${method} ${path}` } }, 400);
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = world.subs.get(sub[1])!;
    const customer = String(row.customer);
    return json({ ...row, customer: { id: customer, email: world.customers.get(customer) ?? "", balance: 0 } });
  }
  if (path === "/invoices") return page(world.invoices.filter((i) => i.subscription === q.get("subscription") && i.status === q.get("status")));
  if (path === "/charges") return page(world.charges.filter((c) => c.customer === q.get("customer")).map((c) => ({ ...c, balance_transaction: "txn_unexpanded" })));
  const charge = path.match(/^\/charges\/(ch_\w+)$/);
  if (charge) return json(world.charges.find((c) => c.id === charge[1]));
  if (path === "/charges/search" || path === "/customers/search") return searchPage([]);
  if (path === "/disputes") return json(world.disputes.get(q.get("charge") ?? "") ?? { object: "list", data: [], has_more: false });
  if (path === "/refunds") return page([]);
  return json({ error: { message: `no stand-in for ${path}` } }, 404);
}) as typeof fetch;

let n = 0;
/** A store whose first plan payment, three days ago, Stripe marks `disputed`. */
async function shop(disputed: unknown = true) {
  n += 1;
  const handle = `owndispute${n}`;
  const email = `${handle}@example.com`;
  const customer = `cus_${handle}0001`;
  const subscriptionId = `sub_${handle}0001`;
  await claimHandle(email, handle, `Own dispute ${n}`, "");
  await setSubscription(email, { customerId: customer, subscriptionId, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  world.customers.set(customer, email);
  world.subs.set(subscriptionId, { id: subscriptionId, status: "active", customer, metadata: { store: handle, tier: "creator" } });
  const at = NOW - 3 * DAY;
  const id = `ch_${handle}x1`;
  const inv = `in_${handle}x1`;
  const pi = `pi_${handle}x1`;
  world.invoices.push({ id: inv, subscription: subscriptionId, status: "paid", created: at, total: 6_900, tax: null, billing_reason: "subscription_create", charge: id, status_transitions: { paid_at: at }, lines: { data: [{ type: "subscription", period: { start: at }, price: { unit_amount: 6_900, currency: "usd", recurring: { interval: "month" } } }] } });
  world.charges.push({ id, customer, invoice: inv, payment_intent: pi, status: "succeeded", paid: true, currency: "usd", created: at, amount_captured: 6_900, amount_refunded: 0, disputed, payment_method_details: { card: { fingerprint: `fp${handle}` } }, balance_transaction: { fee: 230, currency: "usd" } });
  const store = async () => (await storeForEmail(email))!;
  return { id, pi, store, read: async () => (await readPlanRefund(await store(), NOW)).refund };
}

const list = (data: unknown[], more = false) => ({ object: "list", data, has_more: more });
const dispute = (charge: string, status: string) => ({ id: `du_${charge.slice(3)}`, object: "dispute", charge, status, amount: 6_900, currency: "usd" });

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "https://redis.example.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "stand-in-token";

  part("The charge's own dispute decides");
  const own = await shop();
  world.disputes.set(own.id, list([dispute(own.id, "won")]));
  is("its own dispute won: the guarantee applies (unchanged)", await own.read(), { kind: "guarantee", cents: 6_900 });
  const lost = await shop();
  world.disputes.set(lost.id, list([dispute(lost.id, "lost")]));
  is("its own dispute lost: nothing, the bank gave it back (unchanged)", await lost.read(), { kind: "none", reason: "dispute_returned" });

  part("Another charge's dispute is not this charge's");
  const other = await shop();
  world.disputes.set(other.id, list([dispute("ch_somebodyelse01", "won")]));
  is("a won row of another charge: unknown, never a guarantee", await other.read(), { kind: "unknown", reason: "unreadable" });
  const before = world.refundWrites.length;
  const made = await refundPlanPayment(await other.store(), NOW);
  is("and no refund is asked of Stripe for it", [made.ok, world.refundWrites.length - before], [false, 0]);
  const noCharge = await shop();
  world.disputes.set(noCharge.id, list([{ id: "du_nocharge0001", object: "dispute", status: "won", amount: 6_900, currency: "usd" }]));
  is("a row that names no charge: unknown", await noCharge.read(), { kind: "unknown", reason: "unreadable" });

  part("A list not read whole, a status not Stripe's, a flag not in its shape");
  const more = await shop();
  world.disputes.set(more.id, list([dispute(more.id, "won")], true));
  is("a list that says there is more: unknown", await more.read(), { kind: "unknown", reason: "unreadable" });
  const odd = await shop();
  world.disputes.set(odd.id, list([dispute(odd.id, "settled_somehow")]));
  is("a status that is not one of Stripe's: unknown", await odd.read(), { kind: "unknown", reason: "unreadable" });
  const flag = await shop("yes");
  world.disputes.set(flag.id, list([dispute(flag.id, "lost")]));
  is("a `disputed` flag that is not a boolean: unknown, never read as no dispute", await flag.read(), { kind: "unknown", reason: "unreadable" });

  done();
}

void main();
