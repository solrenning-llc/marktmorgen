/**
 * Money end to end: a buyer's membership (a subscription a creator sells through their own connected Stripe account,
 * never the creator's own Marktmorgen plan), driven through the real code against a synthetic stand-in for the
 * creator's Stripe account (no network, no real email).
 *
 * The life of one membership, $20 a month, step by step: the first payment, a renewal, a renewal that fails and is
 * paid on Stripe's retry, a switch to a dearer tier charged at once, a cancellation at the period's end and its undoing,
 * a partial refund of a renewal, and the ways a membership ends. At each step three readers are asked:
 *
 *   - the doors (lib/membership-access.ts: membershipStatus, memberState, isLive, isLiveSub; lib/tier-rules.ts):
 *     open while Stripe calls it active or trialing, or past due with a retry scheduled on its latest invoice, never
 *     paused, cancelled, unpaid, incomplete or past due with no retry;
 *   - the creator's numbers (lib/stats.ts readSales: the checkout, the renewals, the refunds; keptIn): what was charged,
 *     counted once, and charged = refunded + kept;
 *   - the buyer's mail (lib/purchase-email.ts confirmPurchase; lib/payment-recovery.ts recoverFailedPayments): one
 *     confirmation, one email per failed payment, none once it is paid.
 *
 * Every read is also repeated (a replay changes nothing), read out of order, and answered wrongly: a 500, a list of
 * the wrong shape, a reply missing its fields, a reply for another object. None of those may become success, "active",
 * zero or "no refund" (CX-123 rules 24 and 30).
 *
 * Checks headed "RED: MM-E2E-SUB-<n>" fail on main today because the code is wrong; the comment above each names the
 * line and the scenario.
 */
import { addProduct, claimHandle, ensureStatsId, setDunning, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { forgetStatus, isLive, isLiveSub, memberState, membershipStatus, PAST_DUE_NO_RETRY, STATUS_SECONDS } from "@/lib/membership-access";
import { purchaseRefunded } from "@/lib/refunds";
import { readSales, type SalesStats } from "@/lib/stats";
import { confirmPurchase } from "@/lib/purchase-email";
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { chargedOf, switchReply } from "@/lib/tier-switch";
import { currentMeta, productOfSub } from "@/lib/tier-rules";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ACCOUNT = "acct_1TestBuyerSub01";
const OWNER = "owner@buyersubs.example";
const BUYER = "member@buyersubs.example";
const PRICE = 2000;
const SUB = "sub_BuyerMember0001";
const CUS = "cus_BuyerMember001";

// ------------------------------------------------------------------ the creator's Stripe account, synthetic

/** Checkout sessions, as GET /checkout/sessions lists them. */
const sessions: Record<string, unknown>[] = [];
/** Invoices by id, in the order they were made; the list answers newest first, as Stripe does. */
const invoices = new Map<string, Record<string, unknown>>();
/** Refunds, newest first. */
const refunds: Record<string, unknown>[] = [];
/** Subscriptions by id, as GET /subscriptions/:id answers them (latest_invoice not expanded: an id). */
const subs = new Map<string, Record<string, unknown>>();
/** Past-due subscriptions as GET /subscriptions?status=past_due&expand[]=data.latest_invoice&expand[]=data.customer lists them. */
let pastDue: Record<string, unknown>[] = [];
/** Wrong answers to inject, by path: a 500, a list of the wrong shape, a list missing has_more. */
const faults = new Map<string, "500" | "shape" | "no-more" | "repeat">();
/** Subscriptions whose reply names another subscription (a reply that is not the object asked for). */
const foreignSub = new Map<string, Record<string, unknown>>();
const reads = new Map<string, number>();
const emails: { to: string; subject: string; key: string | null }[] = [];

const meta = (product: string) => ({ store: "subshop", product });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push({ to: ([] as string[]).concat(body.to)[0], subject: String(body.subject), key: new Headers(init?.headers).get("Idempotency-Key") });
    return answer({ id: `email_${emails.length}` });
  }
  if (url.hostname !== "api.stripe.com") return answer({ error: "no stand-in" }, 404);
  const path = url.pathname.replace(/^\/v1/, "");
  reads.set(path, (reads.get(path) ?? 0) + 1);
  const fault = faults.get(path);
  if (fault === "500") return answer({ error: { message: "Stripe is down" } }, 500);
  const since = Number(url.searchParams.get("created[gte]") ?? "0");
  const list = (rows: Record<string, unknown>[]) => {
    if (fault === "shape") return answer({ object: "list", data: { rows }, has_more: false });
    if (fault === "no-more") return answer({ object: "list", data: rows });
    if (fault === "repeat" && rows.length) return answer({ object: "list", data: [...rows, rows[0]], has_more: false });
    return answer({ object: "list", data: rows, has_more: false });
  };
  if (method === "GET" && path === "/checkout/sessions") return list(sessions.filter((s) => (s.created as number) >= since));
  if (method === "GET" && path === "/payment_intents") return list([]);
  if (method === "GET" && path === "/disputes") return list([]);
  if (method === "GET" && path === "/refunds") return list(refunds.filter((r) => (r.created as number) >= since));
  if (method === "GET" && path === "/invoices") {
    // Stripe filters by status itself; the code checks it again.
    const status = url.searchParams.get("status");
    const rows = [...invoices.values()].filter((i) => (i.created as number) >= since && (!status || i.status === status)).reverse();
    return list(rows);
  }
  if (method === "GET" && path === "/subscriptions") {
    return list(url.searchParams.get("status") === "past_due" ? pastDue : []);
  }
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/)?.[1];
  if (sub && method === "GET") {
    if (foreignSub.has(sub)) return answer(foreignSub.get(sub));
    return subs.has(sub) ? answer(subs.get(sub)) : answer({ error: { message: "No such subscription" } }, 404);
  }
  if (sub && method === "POST") return answer({ ...(subs.get(sub) ?? {}), id: sub });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

// ------------------------------------------------------------------ Stripe's objects, in their real shapes

let seq = 0;
const nextId = (prefix: string) => `${prefix}_BuyerSub${String((seq += 1)).padStart(8, "0")}`;

/** A paid (or open) invoice of the membership, as the dahlia API answers it: its subscription's metadata under parent. */
function invoice(reason: "subscription_create" | "subscription_cycle" | "subscription_update", cents: number, created: number, product: string, status = "paid"): Record<string, unknown> {
  const id = nextId("in");
  const pi = `pi_${id.slice(3)}`;
  const row: Record<string, unknown> = {
    id,
    object: "invoice",
    status,
    billing_reason: reason,
    amount_due: cents,
    amount_paid: status === "paid" ? cents : 0,
    total: cents,
    currency: "usd",
    created,
    customer: CUS,
    customer_email: BUYER,
    attempt_count: 1,
    next_payment_attempt: status === "open" ? created + 3 * DAY : null,
    hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
    parent: { type: "subscription_details", subscription_details: { subscription: SUB, metadata: meta(product) } },
    payments: { object: "list", data: [{ object: "invoice_payment", status: status === "paid" ? "paid" : "open", payment: { type: "payment_intent", payment_intent: pi } }], has_more: false },
  };
  invoices.set(id, row);
  return row;
}

const intentOf = (inv: Record<string, unknown>) => `pi_${String(inv.id).slice(3)}`;

/** A refund of `cents` on an invoice's payment, as GET /refunds lists it. */
function refund(inv: Record<string, unknown>, cents: number, created: number): void {
  refunds.unshift({ id: nextId("re"), object: "refund", status: "succeeded", amount: cents, currency: "usd", created, payment_intent: intentOf(inv), charge: `ch_${String(inv.id).slice(3)}` });
}

/** The subscription as Stripe answers GET /subscriptions/:id: latest_invoice an id, never expanded. */
function subscription(status: string, product: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SUB,
    object: "subscription",
    status,
    customer: CUS,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    pause_collection: null,
    metadata: meta(product),
    items: { object: "list", data: [{ id: "si_BuyerMember0001", current_period_end: NOW + 20 * DAY, price: { id: "price_BuyerTier0001", metadata: {} } }], has_more: false },
    latest_invoice: "in_BuyerSubLatest01",
    ...extra,
  };
}

// ------------------------------------------------------------------ the store

async function world(): Promise<{ store: Store; club: string; pro: string }> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_money_e2e_buyer_subs_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle(OWNER, "subshop", "Sub Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_SubShopOwner1", subscriptionId: "sub_SubShopOwner1", active: true, period: paidPeriod() });
  const a = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  const b = await addProduct(OWNER, "Supper Club Pro", "", "40", { interval: "month", trialDays: 0, payments: 0 });
  if (!a.ok || !b.ok) throw new Error("no membership");
  await setProductLink(OWNER, a.product.id, "https://example.com/club");
  await setProductLink(OWNER, b.product.id, "https://example.com/pro");
  return { store: (await storeForEmail(OWNER))!, club: a.product.id, pro: b.product.id };
}

/** What the numbers say, in the shape the invariants are written in: the 90 days' kept line in dollars' cents. */
type Ledger = { sales: number; salesCents: number; renewals: number; renewalCents: number; refundCents: number; keptCents: number | null; missing: string[] };
function ledger(stats: SalesStats | null): Ledger | null {
  const line = stats?.keptIn?.d90.lines.find((l) => l.currency === "usd");
  if (!line) return null;
  return { sales: line.sales, salesCents: line.salesCents, renewals: line.renewals, renewalCents: line.renewalCents, refundCents: line.refundCents, keptCents: line.keptCents, missing: line.missing };
}
const numbers = async (store: Store) => ledger(await readSales(store));

/** What the account really holds: every paid invoice charged, every refund given back. */
function account(): { charged: number; refunded: number } {
  const charged = [...invoices.values()].filter((i) => i.status === "paid").reduce((s, i) => s + (i.amount_paid as number), 0);
  const refunded = refunds.reduce((s, r) => s + (r.amount as number), 0);
  return { charged, refunded };
}

/** A fresh read of the membership's state by its id, past the two minutes an answer is kept. */
async function doorById(store: Store): Promise<string | null | "unknown"> {
  await forgetStatus(ACCOUNT, SUB);
  return membershipStatus(store, SUB).then((s) => s, () => "unknown" as const);
}

const runDunning = () => recoverFailedPayments(Date.now() + 20_000);
const dunningTo = (to: string) => emails.filter((e) => e.to === to && /didn't go through|still hasn't gone through/.test(e.subject));

// ------------------------------------------------------------------ scenarios

async function firstPayment(store: Store, club: string): Promise<Record<string, unknown>> {
  part("1. First payment: the checkout paid, the doors open, one confirmation");
  const first = invoice("subscription_create", PRICE, NOW - 40 * DAY + 60, club);
  const session = {
    id: "cs_test_buyersub0first00001",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    amount_subtotal: PRICE,
    amount_total: PRICE,
    currency: "usd",
    created: NOW - 40 * DAY,
    payment_intent: null,
    invoice: first.id,
    subscription: SUB,
    customer: CUS,
    customer_details: { email: BUYER },
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    metadata: meta(club),
  };
  sessions.unshift(session);
  subs.set(SUB, subscription("active", club));

  // Before Stripe settles it: an incomplete first payment opens nothing, and confirms nothing.
  const unpaid = { ...session, id: "cs_test_buyersub0unpaid0001", status: "open", payment_status: "unpaid" };
  is("an unpaid checkout: no confirmation", await confirmPurchase(store, unpaid.id, unpaid as never), "skip");
  is("an incomplete membership (first payment not made): ended", isLiveSub(subscription("incomplete", club)), false);
  is("incomplete_expired: ended", isLiveSub(subscription("incomplete_expired", club)), false);

  // Confirmed when it was paid, 40 days ago: the clock is set to that moment (a confirmation is sent within a day).
  const realNow = Date.now;
  Date.now = () => (session.created + 60) * 1000;
  try {
    is("paid: confirmed", await confirmPurchase(store, session.id, session as never), "sent");
    is("confirmed again (thanks page reopened, the sweep): already, no second email", await confirmPurchase(store, session.id, session as never), "already");
  } finally {
    Date.now = realNow;
  }
  is("one confirmation to the buyer", emails.filter((e) => e.to === BUYER).length, 1);
  is("active: open (by its id)", await doorById(store), "active");
  is("the checkout's own refund reading for a membership: none (doors go by the subscription)", await purchaseRefunded(ACCOUNT, session as never), false);

  const n = await numbers(store);
  is("numbers: the checkout counted once, the first invoice (subscription_create) not counted again",
    n && [n.sales, n.salesCents, n.renewals, n.renewalCents, n.keptCents], [1, PRICE, 0, 0, PRICE]);
  is("read twice: the same numbers", await numbers(store), n);
  return session;
}

async function renewal(store: Store, club: string): Promise<Record<string, unknown>> {
  part("2. Renewal paid: access goes on, the renewal counted once");
  const renewed = invoice("subscription_cycle", PRICE, NOW - 10 * DAY, club);
  subs.set(SUB, subscription("active", club, { latest_invoice: renewed.id }));
  is("still open", await doorById(store), "active");
  const n = await numbers(store);
  is("numbers: one sale, one renewal, kept = both", n && [n.sales, n.renewals, n.renewalCents, n.keptCents], [1, 1, PRICE, 2 * PRICE]);
  is("replay: the same", await numbers(store), n);
  is("stats = ledger: kept = charged - refunded", n?.keptCents, account().charged - account().refunded);
  return renewed;
}

async function dunning(store: Store, club: string): Promise<Record<string, unknown>> {
  part("3. Renewal fails, then Stripe's retry pays it");
  await setDunning(OWNER, { reminders: 1, cardNotice: false });
  const failing = invoice("subscription_cycle", PRICE, NOW - 2 * DAY, club, "open");
  const expanded = (inv: Record<string, unknown>) => ({
    ...subscription("past_due", club),
    latest_invoice: { id: inv.id, object: "invoice", status: inv.status, amount_due: inv.amount_due, currency: "usd", hosted_invoice_url: inv.hosted_invoice_url, next_payment_attempt: inv.next_payment_attempt },
    customer: { id: CUS, object: "customer", email: BUYER },
  });
  subs.set(SUB, subscription("past_due", club, { latest_invoice: failing.id }));
  pastDue = [expanded(failing)];

  is("past due, retry scheduled (subscription with its latest invoice, as readOrder hands it): open (grace)",
    await membershipStatus(store, expanded(failing)), "past_due");
  is("the same, as memberState reads it for course and community doors", isLiveSub(expanded(failing)), true);
  // Documented (lib/membership-access.ts membershipStatus): read by its id alone, the invoice is not expanded, so a
  // past-due membership is ended there.
  is("past due, read by its id alone (invoice not expanded): ended, as documented", await doorById(store), PAST_DUE_NO_RETRY);
  is("past due with the retries over (next_payment_attempt null): ended",
    isLiveSub({ ...expanded(failing), latest_invoice: { ...(expanded(failing).latest_invoice as object), next_payment_attempt: null } }), false);
  is("past due whose retry time does not read (a string): ended, never open",
    isLiveSub({ ...expanded(failing), latest_invoice: { ...(expanded(failing).latest_invoice as object), next_payment_attempt: "soon" } }), false);

  const before = await numbers(store);
  is("the open invoice is not money: numbers unchanged", before && [before.renewals, before.keptCents], [1, 2 * PRICE]);

  await runDunning();
  is("one email about the failed payment", dunningTo(BUYER).length, 1);
  is("its idempotency key names the invoice", dunningTo(BUYER)[0]?.key, `nimbus-dun:${ACCOUNT}:${failing.id}`);
  await runDunning();
  is("the job again the same day: no second email", dunningTo(BUYER).length, 1);

  // Stripe's retry pays it: the invoice is paid, the membership active, nobody past due.
  failing.status = "paid";
  failing.amount_paid = PRICE;
  failing.next_payment_attempt = null;
  failing.attempt_count = 2;
  (failing.payments as { data: { status: string }[] }).data[0].status = "paid";
  subs.set(SUB, subscription("active", club, { latest_invoice: failing.id }));
  pastDue = [];
  await runDunning();
  advance(3 * DAY * 1000);
  await runDunning();
  is("paid: no further email, ever", dunningTo(BUYER).length, 1);
  is("open again", await doorById(store), "active");
  const after = await numbers(store);
  is("the renewal paid on its retry counted once (two renewals, not three)", after && [after.renewals, after.renewalCents, after.keptCents], [2, 2 * PRICE, 3 * PRICE]);
  is("replay: the same", await numbers(store), after);
  is("stats = ledger", after?.keptCents, account().charged - account().refunded);

  part("3b. Dunning on answers that cannot be read: no email, never 'nobody is behind' made up");
  const second = invoice("subscription_cycle", PRICE, NOW - DAY, club, "open");
  const sentBefore = emails.length;
  pastDue = [expanded(second)];
  faults.set("/subscriptions", "500");
  await runDunning();
  is("the past-due list answers 500: no email this run", emails.length, sentBefore);
  faults.set("/subscriptions", "shape");
  await runDunning();
  is("the past-due list in another shape: no email", emails.length, sentBefore);
  faults.delete("/subscriptions");
  pastDue = [{ ...expanded(second), latest_invoice: { ...(expanded(second).latest_invoice as object), currency: undefined } }];
  await runDunning();
  is("an invoice whose currency does not read: no email (the amount would be guessed)", emails.length, sentBefore);
  pastDue = [expanded(second)];
  await runDunning();
  is("the next run that reads it: exactly one email", dunningTo(BUYER).filter((e) => e.key === `nimbus-dun:${ACCOUNT}:${second.id}`).length, 1);
  // It is never paid: voided by the creator, so it leaves the ledger and the dunning list.
  second.status = "void";
  pastDue = [];
  subs.set(SUB, subscription("active", club, { latest_invoice: failing.id }));
  const voided = await numbers(store);
  is("a voided invoice is not money", voided && [voided.renewals, voided.keptCents], [2, 3 * PRICE]);
  return failing;
}

async function tierSwitch(store: Store, club: string, pro: string): Promise<Record<string, unknown>> {
  part("4. The member switches to the dearer tier: charged at once, the doors follow the new tier");
  const at = NOW - 5 * DAY;
  // Stripe's own invoice of an update with proration_behavior=always_invoice (lib/tier-switch.ts switchBody):
  // billing_reason "subscription_update", the prorated difference charged at once.
  const prorated = 1000;
  const sw = invoice("subscription_update", prorated, at, pro);
  const switched = {
    ...subscription("active", pro, { latest_invoice: { ...sw, object: "invoice" } }),
    pending_update: null,
    items: { object: "list", data: [{ id: "si_BuyerMember0001", current_period_end: NOW + 20 * DAY, price: { id: "price_BuyerTierPro01", metadata: { product: pro } } }], has_more: false },
    metadata: { ...meta(pro), switched_from: club },
  };
  is("Stripe's reply to the switch: applied", switchReply(switched, SUB, "price_BuyerTierPro01", ""), "applied");
  is("a reply for another subscription: unknown, never applied", switchReply({ ...switched, id: "sub_SomeoneElse001" }, SUB, "price_BuyerTierPro01", ""), "unknown");
  is("a reply with the update left pending (declined): pending, nothing changed", switchReply({ ...switched, pending_update: { expires_at: NOW + 3600 } }, SUB, "price_BuyerTierPro01", ""), "pending");
  is("a reply with no pending_update field: unknown", switchReply({ ...switched, pending_update: undefined }, SUB, "price_BuyerTierPro01", ""), "unknown");
  is("what the switch charged: the invoice's amount_paid", chargedOf(sw), { cents: prorated, currency: "usd" });
  is("an invoice whose amount_paid does not read: unknown, never 0", chargedOf({ ...sw, amount_paid: undefined }), null);
  is("a downgrade credited: negative, never a charge", chargedOf({ ...sw, total: -500, amount_paid: 0 }), { cents: -500, currency: "usd" });
  is("the doors read the new tier from the price", productOfSub(switched), pro);
  is("the checkout's product, now: the new tier", currentMeta(meta(club), { mode: "subscription", subscription: switched }).product, pro);
  subs.set(SUB, switched);
  is("still open after the switch", await doorById(store), "active");

  const n = await numbers(store);
  const { charged, refunded } = account();
  // RED: MM-E2E-SUB-1. lib/stats.ts:1287 (renewalsFrom) and :1325 (renewalEntries) keep only billing_reason
  // "subscription_cycle" (and :1432, readRenewalPayments, the buyer ledger), so the charge of a tier switch made at once (billing_reason "subscription_update",
  // lib/tier-switch.ts:212, lib/yearly-switch.ts) is never counted in renewals nor in keptIn, while a refund of it is
  // subtracted (readRefunds reads every refund). docs/bx2-earnings-design.md already says the year reading must take
  // "subscription_update"; the 90-day numbers do not.
  part("RED: MM-E2E-SUB-1: a tier switch charged at once is missing from the creator's money");
  is("RED: MM-E2E-SUB-1: kept = charged - refunded after a switch charged at once", n?.keptCents, charged - refunded);
  part("4. (continued)");
  is("the switch is not counted as a second sale (it is no checkout)", n?.sales, 1);
  return sw;
}

async function cancelAndReactivate(store: Store, club: string, pro: string): Promise<void> {
  part("5. Cancel at the period's end: open until then, ended after");
  const end = NOW + 20 * DAY;
  const ending = { ...subscription("active", pro, { cancel_at_period_end: true, cancel_at: end }), items: (subs.get(SUB) as { items: unknown }).items };
  subs.set(SUB, ending);
  is("canceled at the period's end, inside the period: still open", await doorById(store), "active");
  const before = await numbers(store);

  part("6. Undone before the period ends: open, nothing charged again");
  subs.set(SUB, { ...ending, cancel_at_period_end: false, cancel_at: null });
  is("reactivated: open", await doorById(store), "active");
  const after = await numbers(store);
  is("no second charge counted", after, before);

  // The period ends with the cancellation kept: Stripe ends it.
  subs.set(SUB, { ...ending, status: "canceled", canceled_at: end, ended_at: end });
  is("the period over, Stripe ended it: ended", isLive(await doorById(store)), false);

  part("5b. The two minutes an answer is kept (STATUS_SECONDS), as documented");
  subs.set(SUB, subscription("active", club));
  is("read: active", await doorById(store), "active");
  subs.set(SUB, subscription("canceled", club));
  is("canceled at Stripe, read again within the two minutes: the kept answer (documented)", await membershipStatus(store, SUB), "active");
  advance((STATUS_SECONDS + 1) * 1000);
  is("after the two minutes: ended", await membershipStatus(store, SUB), "canceled");
}

async function partialRefund(store: Store, club: string, renewed: Record<string, unknown>): Promise<void> {
  part("7. A renewal partly refunded: kept = charged - refunded, access as the subscription says");
  const before = await numbers(store);
  refund(renewed, 500, NOW - DAY);
  const after = await numbers(store);
  is("refunded $5 of a $20 renewal: kept down by exactly $5", after && before?.keptCents != null && after.keptCents != null ? [after.refundCents - before.refundCents, before.keptCents - after.keptCents] : null, [500, 500]);
  is("charged = refunded + kept", after && after.keptCents !== null ? after.salesCents + after.renewalCents : null, (after?.refundCents ?? 0) + (after?.keptCents ?? NaN));
  is("replay: the same, the refund taken off once", await numbers(store), after);
  subs.set(SUB, subscription("active", club));
  is("the subscription still active: the doors stay open (a refund of a renewal closes nothing by itself)", await doorById(store), "active");
}

async function ended(store: Store, club: string): Promise<void> {
  part("8. After the end: every way it ends shuts the doors");
  for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
    subs.set(SUB, subscription(status, club));
    is(`${status}: ended`, isLive(await doorById(store)), false);
  }
  const pausing = subscription("active", club, { pause_collection: { behavior: "void", resumes_at: NOW + 30 * DAY }, metadata: { ...meta(club), pause_from: String(NOW - DAY) } });
  is("a pause the member chose, running: paused, ended", memberState(pausing), "paused");
  is("a pause not started yet: still open", memberState({ ...pausing, metadata: { ...meta(club), pause_from: String(NOW + DAY) } }), "active");
  is("trialing: open", isLiveSub(subscription("trialing", club)), true);
  is("a status Stripe never sends ('Active'): ended", isLiveSub(subscription("Active", club)), false);
}

async function unknownReplies(store: Store, club: string): Promise<void> {
  part("Unknown replies to the doors: never open");
  subs.set(SUB, subscription("active", club));
  faults.set(`/subscriptions/${SUB}`, "500");
  is("a 500: throws (the door shows an error), never open", await doorById(store), "unknown");
  faults.delete(`/subscriptions/${SUB}`);
  subs.delete(SUB);
  is("404: throws, never open", await doorById(store), "unknown");
  subs.set(SUB, { id: SUB, object: "subscription" });
  is("a reply with no status: unknown (null), never open", await doorById(store), null);
  subs.set(SUB, { id: SUB, object: "subscription", status: 1 });
  is("a status that is not text: unknown", await doorById(store), null);
  is("unknown is not kept: the next read asks Stripe again", (subs.set(SUB, subscription("canceled", club)), await membershipStatus(store, SUB)), "canceled");
  is("an id of the wrong shape: unknown without asking", await membershipStatus(store, "sub_x"), null);
  is("an array for a subscription: unknown", memberState([{ status: "active" }]), null);

  // MM-E2E-SUB-2 (MÉDIO, not fixed here): membershipStatus (lib/membership-access.ts) reads memberState of whatever
  // GET /subscriptions/:id answered, without checking the reply is that subscription (CX-123 rule 30), and keeps it for
  // two minutes, so another member's active membership could open this one's doors. Open PR #2517 adds that check, so
  // it is not repeated here.
  await forgetStatus(ACCOUNT, SUB);
}

async function unknownNumbers(store: Store): Promise<void> {
  part("Unknown replies to the numbers: never zero, never 'no refund'");
  const good = await numbers(store);
  is("the good reading has every part", good?.missing, []);

  faults.set("/invoices", "500");
  let n = await numbers(store);
  is("invoices answer 500: kept unknown (null), renewals named missing", n && [n.keptCents, n.missing.includes("renewals")], [null, true]);
  is("and the renewals are not shown as zero", (await readSales(store))?.renewals, undefined);
  faults.set("/invoices", "shape");
  n = await numbers(store);
  is("invoices in another shape: kept unknown", n?.keptCents, null);
  faults.set("/invoices", "no-more");
  n = await numbers(store);
  is("invoices without has_more: kept unknown", n?.keptCents, null);
  faults.set("/invoices", "repeat");
  n = await numbers(store);
  is("the same invoice listed twice: kept unknown, never counted twice", n?.keptCents, null);
  faults.delete("/invoices");

  faults.set("/refunds", "500");
  n = await numbers(store);
  is("refunds answer 500: kept unknown, never 'no refund'", n && [n.keptCents, n.missing.includes("refunds")], [null, true]);
  const stats = await readSales(store);
  is("refunds by channel: not shown as an empty list", stats?.refundsIn, undefined);
  is("the cash flow is not called complete", stats?.cashflowComplete, false);
  faults.set("/refunds", "no-more");
  is("refunds without has_more: kept unknown", (await numbers(store))?.keptCents, null);
  faults.delete("/refunds");

  faults.set("/checkout/sessions", "500");
  is("checkouts answer 500: no numbers at all, never zero sales", await readSales(store).then(() => "read", () => "unknown"), "unknown");
  faults.delete("/checkout/sessions");

  // A renewal whose currency does not read: the reading says so, never counts it as dollars.
  const odd = invoice("subscription_cycle", PRICE, NOW - 3 * DAY, "x");
  (odd.parent as { subscription_details: { metadata: Record<string, string> } }).subscription_details.metadata = { store: "subshop", product: "x" };
  odd.currency = undefined;
  n = await numbers(store);
  is("a renewal with no currency: renewals partial, kept unknown", n && [n.keptCents, n.missing.includes("renewals")], [null, true]);
  invoices.delete(String(odd.id));

  // Another store's renewal on the same account is not this store's money.
  const other = invoice("subscription_cycle", PRICE, NOW - 3 * DAY, "x");
  (other.parent as { subscription_details: { metadata: Record<string, string> } }).subscription_details.metadata = { store: "othershop", product: "x" };
  is("another store's renewal on the account: not counted", (await numbers(store))?.renewalCents, good?.renewalCents);
  invoices.delete(String(other.id));

  is("all good again: the same reading as before", await numbers(store), good);
}

async function outOfOrder(store: Store, club: string): Promise<void> {
  part("Out of order: the list in any order, the same numbers");
  const before = await numbers(store);
  const entries = [...invoices.entries()];
  invoices.clear();
  for (const [id, row] of entries.reverse()) invoices.set(id, row);
  is("invoices listed oldest first: the same", await numbers(store), before);
  // A refund listed before the renewal it gives back was read (its invoice outside the window): still taken off.
  const old = invoice("subscription_cycle", PRICE, NOW - 200 * DAY, club);
  refund(old, 300, NOW - 2 * DAY);
  const after = await numbers(store);
  is("a refund of a renewal older than the window: taken off this window's kept money once", after && before?.keptCents != null ? [after.refundCents - before.refundCents, before.keptCents - (after.keptCents ?? NaN)] : null, [300, 300]);
}

async function main(): Promise<void> {
  const { store, club, pro } = await world();
  await firstPayment(store, club);
  const renewed = await renewal(store, club);
  await dunning((await storeForEmail(OWNER))!, club);
  await tierSwitch(store, club, pro);
  await cancelAndReactivate(store, club, pro);
  await partialRefund(store, club, renewed);
  await ended(store, club);
  await unknownReplies(store, club);
  await unknownNumbers(store);
  await outOfOrder(store, club);
  done();
}

void main();
