/**
 * Making a plan refund (305 [SY1] unit 2a, lib/plan-refund-write.ts)
 * against a stand-in Stripe that keeps idempotency keys for 24 hours, as
 * Stripe does. Nothing real is reached.
 *
 * What fails here:
 *   - a second refund from a second click, two requests at once, a retry
 *     after a time-out where Stripe had made it, or a refund still pending;
 *   - an amount other than the published policy's;
 *   - a refund where nothing is owed (a dispute, outside the window);
 *   - a refund the bank turned down that is not made again;
 *   - a lock left behind.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { LOCK_SECONDS, WRITE_BY_MS, lockKeyOf, refundPlanPayment } from "@/lib/plan-refund-write";
import { redisPipeline } from "@/lib/redis";

const DAY = 86_400;
let clock = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clock;
const NOW = Date.UTC(2026, 11, 2) / 1000;

type Refund = { id: string; object: "refund"; charge: string; payment_intent: string; amount: number; currency: string; status: string };
const world = {
  customers: new Map<string, string>(),
  subs: new Map<string, Record<string, unknown>>(),
  invoices: [] as Record<string, unknown>[],
  charges: [] as Record<string, unknown>[],
  refunds: [] as Refund[],
  replies: new Map<string, string>(),
  /** Stripe makes the refund, then the answer is lost (a time-out). */
  loseAnswer: false,
  /** New refunds come back with this status. */
  refundStatus: "succeeded",
  /** Every refund write answers 500 before doing anything. */
  writesDown: false,
  slow: 0,
  /** Milliseconds the clock jumps when a charge's refunds are listed (a slow reading before it). */
  jump: 0,
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  if (world.slow) await new Promise((r) => setTimeout(r, world.slow));
  const path = url.pathname.replace(/^\/v1/, "");
  const q = url.searchParams;
  const page = (data: unknown[]) => json({ object: "list", data, has_more: false });
  if (method === "POST" && path === "/refunds") {
    if (world.writesDown) return json({ error: { message: "down" } }, 500);
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    const kept = world.replies.get(key);
    if (kept) return new Response(kept, { status: 200, headers: { "content-type": "application/json" } });
    const form = new URLSearchParams(String(init?.body));
    const charge = world.charges.find((c) => c.payment_intent === form.get("payment_intent"))!;
    const amount = Number(form.get("amount"));
    const refund: Refund = { id: `re_made${world.refunds.length + 1}x`, object: "refund", charge: String(charge.id), payment_intent: String(charge.payment_intent), amount, currency: "usd", status: world.refundStatus };
    world.refunds.push(refund);
    charge.amount_refunded = Number(charge.amount_refunded) + amount;
    world.replies.set(key, JSON.stringify(refund));
    if (world.loseAnswer) throw new TypeError("fetch failed");
    return json(refund);
  }
  if (method !== "GET") return json({ error: { message: "no" } }, 400);
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = world.subs.get(sub[1])!;
    return json({ ...row, customer: { id: row.customer, email: world.customers.get(String(row.customer)), balance: 0 } });
  }
  if (path === "/invoices") return page(world.invoices.filter((i) => i.subscription === q.get("subscription")));
  if (path === "/charges") return page(world.charges.filter((c) => c.customer === q.get("customer")));
  const charge = path.match(/^\/charges\/(ch_\w+)$/);
  if (charge) return json(world.charges.find((c) => c.id === charge[1]));
  if (path === "/charges/search" || path === "/customers/search") return page([]);
  if (path === "/disputes") return page([{ charge: q.get("charge"), status: "needs_response", amount: 6_900 }]);
  if (path === "/refunds" && world.jump) clock += world.jump;
  if (path === "/refunds") return page(world.refunds.filter((r) => r.charge === q.get("charge")));
  return json({ error: { message: `no stand-in for ${path}` } }, 404);
}) as typeof fetch;

let n = 0;
async function paidShop(o: { at?: number; disputed?: boolean } = {}) {
  n += 1;
  const handle = `buy${n}`;
  const email = `${handle}@example.com`;
  const customer = `cus_${handle}0001`;
  const sub = `sub_${handle}0001`;
  await claimHandle(email, handle, `Buy ${n}`, "");
  await setSubscription(email, { customerId: customer, subscriptionId: sub, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  world.customers.set(customer, email);
  world.subs.set(sub, { id: sub, customer, metadata: { store: handle } });
  const at = o.at ?? NOW - 3 * DAY;
  const id = `ch_${handle}x1`;
  world.invoices.push({ id: `in_${handle}x1`, subscription: sub, status: "paid", created: at, total: 6_900, tax: null, billing_reason: "subscription_create", charge: id, status_transitions: { paid_at: at }, lines: { data: [{ type: "subscription", period: { start: at }, price: { unit_amount: 6_900, currency: "usd", recurring: { interval: "month" } } }] } });
  world.charges.push({ id, customer, invoice: `in_${handle}x1`, payment_intent: `pi_${handle}x1`, status: "succeeded", paid: true, currency: "usd", created: at, amount_captured: 6_900, amount_refunded: 0, disputed: o.disputed ?? false, payment_method_details: { card: { fingerprint: `fp${handle}` } }, balance_transaction: { fee: 230, currency: "usd" } });
  const store = async () => (await storeForEmail(email))!;
  return { id, store, refunds: () => world.refunds.filter((r) => r.charge === id) };
}
const lockOf = async (s: { sid: string }) => (await redisPipeline([["GET", lockKeyOf(s.sid)]]))[0];

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";

  part("The refund, once");
  const a = await paidShop();
  const first = await refundPlanPayment(await a.store(), NOW);
  is("the first payment comes back in full", first, { ok: true, cents: 6_900, currency: "usd", refundId: "re_made1x", refundIds: ["re_made1x"], status: "succeeded" });
  is("a second click gives nothing more", (await refundPlanPayment(await a.store(), NOW)), { ok: false, reason: "not_owed" });
  is("one refund at Stripe, for the policy's amount", a.refunds().map((r) => r.amount), [6_900]);
  is("the lock is gone", await lockOf(await a.store()), null);

  part("Two requests at once");
  const b = await paidShop();
  world.slow = 5;
  const both = await Promise.all([refundPlanPayment(await b.store(), NOW), refundPlanPayment(await b.store(), NOW)]);
  world.slow = 0;
  is("one is made, the other is told to wait", both.map((r) => (r.ok ? "made" : r.reason)).sort(), ["busy", "made"]);
  is("one refund at Stripe", b.refunds().length, 1);

  part("A time-out after Stripe made it");
  const c = await paidShop();
  world.loseAnswer = true;
  is("the answer lost: said failed, never made again", await refundPlanPayment(await c.store(), NOW), { ok: false, reason: "failed" });
  world.loseAnswer = false;
  is("asked again: nothing owed any more, still one refund", [await refundPlanPayment(await c.store(), NOW), c.refunds().length], [{ ok: false, reason: "not_owed" }, 1]);
  const cs = await paidShop();
  world.loseAnswer = true;
  await refundPlanPayment(await cs.store(), NOW);
  world.loseAnswer = false;
  // Stripe's charge and refund list have not caught up yet: only the idempotency key stands between us and a second refund.
  world.charges.find((x) => x.id === cs.id)!.amount_refunded = 0;
  const hidden = world.refunds.splice(world.refunds.findIndex((r) => r.charge === cs.id), 1)[0];
  const replay = await refundPlanPayment(await cs.store(), NOW);
  world.refunds.push(hidden);
  is("retried before Stripe's reads catch up: the key replays the first refund, none new", [replay.ok && replay.refundId, cs.refunds().length], [hidden.id, 1]);
  const c2 = await paidShop();
  world.writesDown = true;
  is("Stripe failing before it made anything: failed, lock released", [await refundPlanPayment(await c2.store(), NOW), await lockOf(await c2.store())], [{ ok: false, reason: "failed" }, null]);
  world.writesDown = false;
  is("asked again once Stripe is back: made, once", [(await refundPlanPayment(await c2.store(), NOW)).ok, c2.refunds().length], [true, 1]);

  part("Pending and turned down");
  const d = await paidShop();
  world.refundStatus = "pending";
  is("a pending refund is reported as pending", (await refundPlanPayment(await d.store(), NOW)).ok && d.refunds()[0].status, "pending");
  world.refundStatus = "succeeded";
  is("while it is pending, nothing new is made", [await refundPlanPayment(await d.store(), NOW), d.refunds().length], [{ ok: false, reason: "not_owed" }, 1]);
  // The bank turns it down: Stripe gives the amount back to the charge.
  const dCharge = world.charges.find((x) => x.id === d.id)!;
  d.refunds()[0].status = "failed";
  dCharge.amount_refunded = 0;
  const again = await refundPlanPayment(await d.store(), NOW);
  is("turned down: made again under a new key, once", [again.ok, d.refunds().map((r) => r.status)], [true, ["failed", "succeeded"]]);
  const e = await paidShop();
  world.refunds.push({ id: "re_pendingold1", object: "refund", charge: e.id, payment_intent: `pi_buy${n}x1`, amount: 100, currency: "usd", status: "pending" });
  world.charges.find((x) => x.id === e.id)!.amount_refunded = 100;
  is("a refund already pending on the charge: nothing new", [await refundPlanPayment(await e.store(), NOW), e.refunds().length], [{ ok: false, reason: "pending" }, 1]);

  part("The lock outlasts the write");
  is("the lock covers the reading's budget, a list and a write for each payment, and a minute", [LOCK_SECONDS, WRITE_BY_MS], [345, 265_000]);
  const late = await paidShop();
  world.jump = WRITE_BY_MS + 1;
  is("past the write's last moment: nothing made, failed, the lock released", [await refundPlanPayment(await late.store(), NOW), late.refunds().length, await lockOf(await late.store())], [{ ok: false, reason: "failed" }, 0, null]);
  world.jump = 0;
  is("asked again in time: made, once", [(await refundPlanPayment(await late.store(), NOW)).ok, late.refunds().length], [true, 1]);

  part("Nothing owed, nothing made");
  const f = await paidShop({ disputed: true });
  is("an open dispute: not owed", [await refundPlanPayment(await f.store(), NOW), f.refunds().length], [{ ok: false, reason: "not_owed" }, 0]);
  const g = await paidShop({ at: NOW - 31 * DAY });
  is("outside the 30 days: not owed", [await refundPlanPayment(await g.store(), NOW), g.refunds().length], [{ ok: false, reason: "not_owed" }, 0]);
  const u = await paidShop();
  world.charges.find((x) => x.id === u.id)!.amount_captured = 4_900;
  is("not decidable (part paid by a balance): unknown, nothing made", [await refundPlanPayment(await u.store(), NOW), u.refunds().length], [{ ok: false, reason: "unknown" }, 0]);
  const h = await paidShop();
  await redisPipeline([["SET", lockKeyOf((await h.store()).sid), "someone-else", "EX", 60]]);
  is("another request holds the lock: busy, and its lock is left alone", [await refundPlanPayment(await h.store(), NOW), await lockOf(await h.store())], [{ ok: false, reason: "busy" }, "someone-else"]);
  done();
}

void main();
