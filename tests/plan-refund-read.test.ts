/**
 * Reading a store's plan refund from our own Stripe account (305 [SY1]
 * unit 1, lib/plan-refund.ts), against a stand-in Stripe. Nothing real is
 * reached and nothing is written to Stripe.
 *
 * What fails here:
 *   - an amount that differs from the published policy (the guarantee net of
 *     a coupon, what is left after a partial refund, a yearly plan's months
 *     not started less Stripe's fee);
 *   - a guarantee given a second time to the same person (same address on
 *     another customer, same card), or after the window;
 *   - a refund offered while a dispute is open (on Stripe or on the store's
 *     record), or for a payment refunded already;
 *   - a silent no where the answer cannot be read (a failing Stripe, a list
 *     longer than a page, a payment split with a balance, a fee in another
 *     currency, too many same-address customers);
 *   - any write to Stripe, or more requests than MAX_CALLS.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, recordPlanDispute, setSubscription, storeForEmail } from "@/lib/store";
import { MAX_CALLS, monthlyForYearly, readPlanRefund } from "@/lib/plan-refund";

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
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = world.subs.get(sub[1]);
    if (!row) return json({ error: { message: "No such subscription" } }, 404);
    const customer = String(row.customer);
    return json({ ...row, customer: q.getAll("expand[]").includes("customer") ? { id: customer, email: world.customers.get(customer) ?? "", balance: world.balance.get(customer) ?? 0 } : customer });
  }
  if (path === "/invoices") {
    return page(world.invoices.filter((i) => i.subscription === q.get("subscription") && i.status === q.get("status")).sort((a, b) => Number(b.created) - Number(a.created)));
  }
  if (path === "/charges") {
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
    const row = world.charges.find((c) => c.id === charge[1]);
    return row ? json(row) : json({ error: { message: "No such charge" } }, 404);
  }
  if (path === "/charges/search") {
    const query = q.get("query") ?? "";
    const fp = query.match(/fingerprint:"(\w+)"/)?.[1];
    const lt = Number(query.match(/created<(\d+)/)?.[1] ?? Infinity);
    return page(world.charges.filter((c) => (c.payment_method_details as { card: { fingerprint: string } }).card.fingerprint === fp && c.status === "succeeded" && c.created < lt));
  }
  if (path === "/customers/search") {
    const email = (q.get("query") ?? "").match(/email:"([^"]+)"/)?.[1];
    return page([...world.customers].filter(([, e]) => e === email).map(([id, e]) => ({ id, email: e })));
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

  part("The 30-day guarantee on the first payment");
  const a = await shop();
  const aPaid = pay(a, { at: NOW - 3 * DAY });
  is("the first payment within 30 days comes back in full", await a.read(), { refund: { kind: "guarantee", cents: 6_900 }, chargeId: aPaid.id, paymentIntent: aPaid.pi, invoiceId: aPaid.inv, currency: "usd", parts: [{ chargeId: aPaid.id, paymentIntent: aPaid.pi, invoiceId: aPaid.inv, cents: 6_900, paidAtSeconds: NOW - 3 * DAY }] });
  const b = await shop();
  pay(b, { at: NOW - 3 * DAY, amount: 3_450 });
  is("a coupon: what the card paid, never the list price", ((await b.read()).refund), { kind: "guarantee", cents: 3_450 });
  const c = await shop();
  pay(c, { at: NOW - 31 * DAY });
  is("31 days later: nothing, and why", (await c.read()).refund, { kind: "none", reason: "outside_window" });
  const d = await shop();
  pay(d, { at: NOW - 40 * DAY });
  pay(d, { at: NOW - 10 * DAY, reason: "subscription_cycle" });
  is("a monthly renewal: nothing", (await d.read()).refund, { kind: "none", reason: "renewal" });
  const e = await shop();
  pay(e, { at: NOW - 3 * DAY, refunded: 1_000 });
  is("refunded in part: only what is left", (await e.read()).refund, { kind: "guarantee", cents: 5_900 });
  const f = await shop();
  pay(f, { at: NOW - 3 * DAY, refunded: 6_900 });
  is("refunded in full already: nothing again", (await f.read()).refund, { kind: "none", reason: "already_refunded" });

  part("Once per person");
  const g = await shop();
  const gTwin = `cus_shop${n}twin`;
  world.customers.set(gTwin, g.email);
  world.charges.push({ id: `ch_twin${n}`, customer: gTwin, created: NOW - 20 * DAY, status: "succeeded", paid: true, payment_method_details: { card: { fingerprint: "fpother" } } });
  pay(g, { at: NOW - 3 * DAY });
  is("another customer with the same address paid before: no second guarantee", (await g.read()).refund, { kind: "none", reason: "guarantee_used" });
  const h = await shop();
  world.charges.push({ id: `ch_card${n}`, customer: "cus_someoneelse01", created: NOW - 20 * DAY, status: "succeeded", paid: true, payment_method_details: { card: { fingerprint: "fpsamecard" } } });
  pay(h, { at: NOW - 3 * DAY, card: "fpsamecard" });
  is("the same card paid before on another customer: no second guarantee", (await h.read()).refund, { kind: "none", reason: "guarantee_used" });
  const i = await shop();
  pay(i, { at: NOW - 5 * DAY, subscription: "sub_anotherstore01" });
  pay(i, { at: NOW - 2 * DAY });
  is("the account's first payment was another store's: not here", (await i.read()).refund, { kind: "none", reason: "renewal" });
  const again = await shop();
  world.subs.set("sub_againold0001", { id: "sub_againold0001", status: "canceled", customer: again.customer, metadata: { store: again.handle } });
  pay(again, { at: NOW - 5 * DAY, subscription: "sub_againold0001" });
  pay(again, { at: NOW - 2 * DAY });
  is("the first payment was this store's earlier plan: unknown, never a silent no", (await again.read()).refund, { kind: "unknown", reason: "not_this_store" });
  const trial = await shop();
  world.invoices.push({ id: `in_trial${n}`, subscription: trial.subscriptionId, status: "paid", created: NOW - DAY, total: 0, tax: null, billing_reason: "subscription_create", charge: null, lines: { data: [] } });
  is("a trial's invoice paid with no charge: no payment yet", (await trial.read()).refund, { kind: "none", reason: "no_plan_payment" });
  const many = await shop();
  for (let k = 0; k < 6; k += 1) world.customers.set(`cus_many${n}k${k}`, many.email);
  pay(many, { at: NOW - 3 * DAY });
  is("more same-address customers than can be read: unknown, not no", (await many.read()).refund, { kind: "unknown", reason: "too_many" });

  part("Disputes");
  const j = await shop();
  const jPaid = pay(j, { at: NOW - 3 * DAY, disputed: true });
  world.disputes.push({ id: "du_j", charge: jPaid.id, status: "needs_response", amount: 6_900 });
  is("open on Stripe: no refund now", (await j.read()).refund, { kind: "none", reason: "dispute_open" });
  const k2 = await shop();
  pay(k2, { at: NOW - 3 * DAY });
  await recordPlanDispute(k2.email, { id: "du_k2open01", status: "open", at: NOW - DAY, coversUntil: NOW + 20 * DAY }, NOW);
  const before = world.calls;
  is("open on the store's record: no refund, no request", [(await k2.read()).refund, world.calls - before], [{ kind: "none", reason: "dispute_open" }, 0]);
  const l = await shop();
  const lPaid = pay(l, { at: NOW - 3 * DAY, disputed: true });
  world.disputes.push({ id: "du_l", charge: lPaid.id, status: "won", amount: 6_900 });
  is("a dispute we won: the guarantee applies again", (await l.read()).refund, { kind: "guarantee", cents: 6_900 });

  part("Yearly plans: the months not started");
  is("the monthly price of today's yearly price", monthlyForYearly(69_000), 6_900);
  is("a yearly price never published: unknown", monthlyForYearly(12_345), null);
  const y = await shop("year");
  const start = Date.UTC(2026, 7, 15) / 1000;
  pay(y, { at: start, cycle: "year", fee: 2_031 });
  is("four months started of twelve (Aug 15 to Dec 2): 69,000 − 4 × 6,900 − the fee", (await y.read()).refund, { kind: "unstarted_months", cents: 69_000 - 4 * 6_900 - 2_031, monthsKept: 4 });
  const yt = await shop("year");
  pay(yt, { at: start, cycle: "year", amount: 79_000, total: 79_000, tax: 10_000, fee: 2_031 });
  is("tax comes back in proportion, rounded down", (await yt.read()).refund, { kind: "unstarted_months", cents: 69_000 - 4 * 6_900 + Math.floor((10_000 * (69_000 - 4 * 6_900)) / 69_000) - 2_031, monthsKept: 4 });
  const yc = await shop("year");
  pay(yc, { at: start, cycle: "year", feeCurrency: "eur" });
  is("Stripe's fee in another currency: unknown", (await yc.read()).refund, { kind: "unknown", reason: "currency" });
  const yf = await shop("year");
  pay(yf, { at: NOW - 10 * DAY, cycle: "year" });
  is("a first yearly payment within 30 days: the guarantee, in full", (await yf.read()).refund, { kind: "guarantee", cents: 69_000 });

  part("What cannot be read is never a no");
  const s = await shop();
  pay(s, { at: NOW - 3 * DAY, amount: 4_900, total: 6_900 });
  is("part paid by a balance: unknown", (await s.read()).refund, { kind: "unknown", reason: "split_payment" });
  const m = await shop();
  pay(m, { at: NOW - 3 * DAY });
  world.moreCharges = true;
  is("more charges than one page, the oldest listed recent: unknown", (await m.read()).refund, { kind: "unknown", reason: "too_many" });
  world.moreCharges = false;
  // The newest page holds only declined charges and more follow: the first payment may be on the next page.
  const fp = await shop();
  pay(fp, { at: NOW - 20 * DAY });
  for (let i = 0; i < 100; i += 1) world.charges.push({ id: `ch_declined${n}x${i}`, customer: fp.customer, created: NOW - 2 * DAY + i, status: "failed", paid: false, payment_method_details: { card: { fingerprint: "fpdeclined" } } });
  world.moreCharges = true;
  is("a full page of declined charges inside the 30 days, more after it: unknown, never the guarantee skipped", (await fp.read()).refund, { kind: "unknown", reason: "too_many" });
  world.moreCharges = false;
  // One payment 20 days ago, then a long history of declined charges before it: the page ends outside the window,
  // but the payment inside it may be the first one or not, and the rest is not read.
  const dp = await shop();
  pay(dp, { at: NOW - 20 * DAY });
  for (let i = 0; i < 100; i += 1) world.charges.push({ id: `ch_olddecl${n}x${i}`, customer: dp.customer, created: NOW - 40 * DAY - i, status: "failed", paid: false, payment_method_details: { card: { fingerprint: "fpdeclined" } } });
  world.moreCharges = true;
  is("a payment inside the window with more pages after it: unknown, never a silent renewal", (await dp.read()).refund, { kind: "unknown", reason: "too_many" });
  world.moreCharges = false;
  // A long-time customer: a payment 40 days ago is on the page, so the renewal 5 days ago is certainly not the first.
  const lt = await shop();
  pay(lt, { at: NOW - 40 * DAY });
  pay(lt, { at: NOW - 5 * DAY, reason: "subscription_cycle" });
  for (let i = 0; i < 100; i += 1) world.charges.push({ id: `ch_ltdecl${n}x${i}`, customer: lt.customer, created: NOW - 60 * DAY - i, status: "failed", paid: false, payment_method_details: { card: { fingerprint: "fpdeclined" } } });
  world.moreCharges = true;
  is("more pages, but a payment before the window is listed: the renewal is a renewal", (await lt.read()).refund, { kind: "none", reason: "renewal" });
  world.moreCharges = false;
  // A downgrade the day after leaves a credit on the customer's balance: refunding the whole payment would give back more than was paid.
  const cr = await shop();
  pay(cr, { at: NOW - 3 * DAY });
  world.balance.set(cr.customer, -37_000);
  is("a credit on the customer's balance: unknown, never the whole payment on top of it", (await cr.read()).refund, { kind: "unknown", reason: "customer_credit" });
  world.balance.set(cr.customer, 500);
  is("an amount owed on the balance (not a credit): the guarantee as before", (await cr.read()).refund, { kind: "guarantee", cents: 6_900 });
  world.balance.set(cr.customer, Number.NaN);
  is("a balance that cannot be read: unknown", (await cr.read()).refund, { kind: "unknown", reason: "unreadable" });
  world.down = true;
  is("Stripe failing: unknown", (await a.read()).refund, { kind: "unknown", reason: "stripe_unread" });
  world.down = false;
  const none = await shop();
  await setSubscription(none.email, { customerId: null, subscriptionId: null, active: false });
  const quiet = world.calls;
  is("no plan payment at all: nothing, with no request", [(await none.read()).refund, world.calls - quiet], [{ kind: "none", reason: "no_plan_payment" }, 0]);
  const o = await shop();
  world.subs.set(o.subscriptionId, { ...world.subs.get(o.subscriptionId)!, metadata: { store: "someone-else" } });
  pay(o, { at: NOW - 3 * DAY });
  is("a subscription that is not this store's: unknown", (await o.read()).refund, { kind: "unknown", reason: "not_this_store" });

  part("Every plan payment made within the guarantee's days (owner, 31/10/2026 15h41)");
  // Pay 1 Feb, renew 1 Mar, ask 2 Mar: both come back.
  const feb = await shop();
  const fFirst = pay(feb, { at: NOW - 29 * DAY });
  const fRenew = pay(feb, { at: NOW - DAY, reason: "subscription_cycle" });
  const both = await feb.read();
  is("the first payment and the renewal inside the window: both, in full", [both.refund, "parts" in both && both.parts.map((p) => [p.chargeId, p.cents])], [{ kind: "guarantee", cents: 13_800 }, [[fFirst.id, 6_900], [fRenew.id, 6_900]]]);
  is("the first part is the first payment", "chargeId" in both && both.chargeId, fFirst.id);
  const late = await shop();
  pay(late, { at: NOW - 31 * DAY });
  pay(late, { at: NOW - 2 * DAY, reason: "subscription_cycle" });
  is("asked after the first payment's days: the renewal is never judged a first payment", (await late.read()).refund, { kind: "none", reason: "renewal" });
  const sw = await shop();
  pay(sw, { at: NOW - 20 * DAY });
  pay(sw, { at: NOW - 5 * DAY, amount: 38_000, total: 38_000, reason: "subscription_update" });
  is("a plan switch charged inside the window comes back too", (await sw.read()).refund, { kind: "guarantee", cents: 6_900 + 38_000 });
  const dsp = await shop();
  pay(dsp, { at: NOW - 20 * DAY });
  const dspRenew = pay(dsp, { at: NOW - 2 * DAY, reason: "subscription_cycle", disputed: true });
  world.disputes.push({ charge: dspRenew.id, status: "needs_response", amount: 6_900 });
  const dspRead = await dsp.read();
  is("a renewal in an open dispute is left to the dispute; the first payment still comes back", [dspRead.refund, "parts" in dspRead && dspRead.parts.length], [{ kind: "guarantee", cents: 6_900 }, 1]);
  const part2 = await shop();
  pay(part2, { at: NOW - 20 * DAY, refunded: 6_900 });
  const rest = pay(part2, { at: NOW - 3 * DAY, reason: "subscription_cycle" });
  const restRead = await part2.read();
  is("the first already given back (a refund cut half way): the rest of the window still comes back", ["parts" in restRead && restRead.parts.map((p) => p.chargeId), restRead.refund], [[rest.id], { kind: "guarantee", cents: 6_900 }]);
  const crowd = await shop();
  pay(crowd, { at: NOW - 25 * DAY });
  for (let i = 0; i < 6; i += 1) pay(crowd, { at: NOW - 20 * DAY + i * DAY, amount: 1_000, total: 1_000, reason: "subscription_update" });
  is("more payments in the window than one refund gives back at once: unknown, for support", (await crowd.read()).refund, { kind: "unknown", reason: "too_many" });

  part("Bounds");
  let most = 0;
  for (const shopOf of [a, g, h, y, many, again]) {
    const was = world.calls;
    await shopOf.read();
    most = Math.max(most, world.calls - was);
  }
  is(`never more than ${MAX_CALLS} requests in one reading`, most <= MAX_CALLS, true);
  is("nothing is ever written to Stripe", world.writes, 0);
  done();
}

void main();
