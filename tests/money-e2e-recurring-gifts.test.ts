/**
 * Money end to end: payment plans (instalments), memberships, gifts and pre-orders, driven through the real code
 * against a synthetic stand-in for the creator's Stripe account (no network, no real email).
 *
 * The rules checked are the code's own (lib/refunds.ts header; lib/membership-access.ts header; lib/gifts.ts;
 * lib/preorders.ts):
 *
 *   - a payment plan is judged by its FIRST invoice's payment: refunded in full or lost to a dispute closes it; a
 *     partial refund, an open or won dispute, or a later instalment refunded or lost closes nothing; what Stripe does
 *     not answer for this invoice reads as not refunded (a door that lets in), never as given back by someone else's
 *     money;
 *   - a membership's doors go by its subscription's state (active, trialing, past due with a retry scheduled);
 *   - a gift, and a pre-order handed over, are written under the recipient's address and taken back by the refund
 *     jobs on a full refund or a lost dispute, once; a partial refund keeps them; replays give and email once;
 *   - a pre-order refunded before its release is never handed over.
 *
 * The blocks headed "Was RED" (bugs on main at f964dbd9, fixed in this pull request) are kept apart at the end.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, readGift, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { importedFor } from "@/lib/imported-purchases";
import { confirmPreorder, queueRelease, readPreorder, revokeRefundedPreorders, runPreorderReleases, setExpectedDay, waitingCount } from "@/lib/preorders";
import { disputeLost, purchaseRefunded } from "@/lib/refunds";
import { isLive, membershipStatus } from "@/lib/membership-access";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
const ACCOUNT = "acct_1TestMoneyRec01";
const OWNER = "owner@recurring.example";
const PRICE = 2500;

// ------------------------------------------------------------------ the creator's Stripe account, synthetic

type Pay = { amount: number; back: number; disputed?: boolean };
const pays = new Map<string, Pay>();
const chargeId = (pi: string) => `ch_${pi.slice(3)}`;
/** Refunds, newest first, as GET /refunds lists them with their charge expanded. */
const refundRows: Record<string, unknown>[] = [];
/** charge.dispute.closed events, newest first. */
const closings: Record<string, unknown>[] = [];
const disputes = new Map<string, { status: string }[]>();
const invoices = new Map<string, Record<string, unknown>>();
const invoicePayments = new Map<string, { data: unknown[]; has_more: boolean }>();
const subscriptions = new Map<string, Record<string, unknown>>();
/** Payments whose reply names another payment (a reply that is not the object asked for). */
const foreign = new Set<string>();
const emails: { to: string; subject: string; key: string | null; text: string }[] = [];

function charge(pi: string): Record<string, unknown> {
  const p = pays.get(pi) ?? { amount: PRICE, back: 0 };
  return { object: "charge", id: chargeId(pi), payment_intent: pi, amount: p.amount, amount_refunded: p.back, refunded: p.back >= p.amount, disputed: p.disputed === true };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push({ to: ([] as string[]).concat(body.to)[0], subject: body.subject, key: new Headers(init?.headers).get("Idempotency-Key"), text: String(body.text ?? "") });
    return answer({ id: `email_${emails.length}` });
  }
  if (url.hostname !== "api.stripe.com") return answer({ error: "no stand-in" }, 404);
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/refunds") {
    const since = Number(url.searchParams.get("created[gte]") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const listed = refundRows.filter((row) => (row.created as number) >= since);
    const from = after ? listed.findIndex((row) => row.id === after) + 1 : 0;
    return answer({ object: "list", data: listed.slice(from, from + limit), has_more: from + limit < listed.length });
  }
  if (path === "/events") {
    const since = Number(url.searchParams.get("created[gte]") ?? "0");
    return answer({ object: "list", data: closings.filter((e) => (e.created as number) >= since), has_more: false });
  }
  if (path === "/disputes") {
    const ch = url.searchParams.get("charge") ?? "";
    return answer({ object: "list", data: (disputes.get(ch) ?? []).map((d, i) => ({ id: `dp_${ch.slice(3)}${i}`, object: "dispute", charge: ch, status: d.status })), has_more: false });
  }
  const intent = path.match(/^\/payment_intents\/(pi_\w+)$/)?.[1];
  if (intent) {
    if (foreign.has(intent)) return answer({ id: "pi_someoneelse0001", object: "payment_intent", latest_charge: { object: "charge", id: "ch_someoneelse0001", refunded: true, amount: PRICE, amount_refunded: PRICE } });
    return answer({ id: intent, object: "payment_intent", amount: pays.get(intent)?.amount ?? PRICE, latest_charge: charge(intent) });
  }
  const invoice = path.match(/^\/invoices\/(in_\w+)$/)?.[1];
  if (invoice) return invoices.has(invoice) ? answer(invoices.get(invoice)) : answer({ error: { message: "No such invoice" } }, 404);
  if (path === "/invoice_payments") return answer({ object: "list", ...(invoicePayments.get(url.searchParams.get("invoice") ?? "") ?? { data: [], has_more: false }) });
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/)?.[1];
  if (sub) return subscriptions.has(sub) ? answer(subscriptions.get(sub)) : answer({ error: { message: "No such subscription" } }, 404);
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

let clock = NOW - 50_000;
const tick = () => (clock += 10);
let refundSeq = 0;
/** A refund of `back` cents more on a payment; the charge then says what has gone back in all. */
function refund(pi: string, back: number): void {
  const p = pays.get(pi) ?? { amount: PRICE, back: 0 };
  p.back = Math.min(p.amount, p.back + back);
  pays.set(pi, p);
  refundSeq += 1;
  refundRows.unshift({ id: `re_money${String(refundSeq).padStart(8, "0")}`, object: "refund", created: tick(), status: "succeeded", amount: back, payment_intent: pi, charge: charge(pi) });
}
let eventSeq = 0;
/** A dispute on a payment, open, won or lost; a closing event when it closes. */
function dispute(pi: string, status: "needs_response" | "won" | "lost"): void {
  const p = pays.get(pi) ?? { amount: PRICE, back: 0 };
  pays.set(pi, { ...p, disputed: true });
  disputes.set(chargeId(pi), [{ status }]);
  if (status === "needs_response") return;
  eventSeq += 1;
  closings.unshift({ id: `evt_money${String(eventSeq).padStart(8, "0")}`, object: "event", type: "charge.dispute.closed", created: tick(), data: { object: { object: "dispute", status, payment_intent: pi, charge: chargeId(pi), amount: p.amount } } });
}

// ------------------------------------------------------------------ the store

async function world(): Promise<{ store: Store; giftable: Listing; book: Listing }> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_money_e2e_recurring_only";
  process.env.RESEND_API_KEY = "re_test_only";
  await claimHandle(OWNER, "recurshop", "Recur Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_RecurOwner01", subscriptionId: "sub_RecurOwner01", active: true, period: paidPeriod() });
  const a = await addProduct(OWNER, "Gift Course", "", "25", null);
  const b = await addProduct(OWNER, "Bread Book", "", "25", null);
  if (!a.ok || !b.ok) throw new Error("no product");
  await setProductLink(OWNER, a.product.id, "https://example.com/gift");
  await setProductLink(OWNER, b.product.id, "https://example.com/book");
  const store = (await storeForEmail(OWNER))!;
  return { store, giftable: (await readListing(store, a.product.id))!, book: (await readListing(store, b.product.id))! };
}

const deps = {
  base: "https://marktmorgen.com/@recurshop",
  from: '"Recur Shop" <hello@marktmorgen.com>',
  ordersLink: async (email: string) => `https://marktmorgen.com/@recurshop/orders?for=${encodeURIComponent(email)}`,
  recordStart: async () => {},
};
const pad = (n: number) => String(n).padStart(8, "0");
const dropped: string[] = [];
const drop = async (email: string, productId: string) => void dropped.push(`${email}|${productId}`);

async function holds(store: Store, email: string, productId: string): Promise<number> {
  return (await importedFor((await storeForEmail(OWNER)) ?? store, email)).filter((p) => p.productId === productId).length;
}

/** A gift paid with `pi`, handed over through the same call confirmGift (lib/purchase-email.ts) makes. */
async function giveGift(store: Store, product: Listing, n: number, before?: () => Promise<void>) {
  const to = `friend${n}@recurring.example`;
  const pi = `pi_gift${pad(n)}`;
  pays.set(pi, { amount: PRICE, back: 0 });
  const started = await startGift(store, product, { to, from: "Ana", message: "" });
  if (!started.ok) throw new Error(`no gift ${n}`);
  const session = { id: `cs_test_gift${pad(n)}abcd`, created: NOW - 40_000, amount_total: PRICE, currency: "usd", payment_intent: pi, metadata: { store: "recurshop", product: product.id, gift: started.gift.id }, customer_details: { email: `buyer${n}@recurring.example` } };
  if (before) await before();
  const deliver = () => deliverGift({ store, session: session as never, product, base: deps.base, from: deps.from, recordStart: async () => {}, ordersLink: async () => null });
  return { to, pi, id: started.gift.id, deliver };
}

function preSession(product: Listing, n: number) {
  const pi = `pi_pre${pad(n)}`;
  if (!pays.has(pi)) pays.set(pi, { amount: PRICE, back: 0 });
  return { id: `cs_test_pre${pad(n)}abcde`, created: NOW - 40_000, status: "complete", payment_status: "paid", amount_total: PRICE, currency: "usd", payment_intent: pi, metadata: { store: "recurshop", product: product.id, preorder: "yes" }, customer_details: { email: `pre${n}@recurring.example` } };
}

const runGifts = (store: Store) => revokeRefundedGifts(store, Date.now() + 60_000, drop);
const runPre = (store: Store) => revokeRefundedPreorders(store, Date.now() + 60_000, drop);

// ------------------------------------------------------------------ scenarios

async function paymentPlans(): Promise<void> {
  part("Payment plan, three instalments: judged by the first invoice's payment");
  const session = (invoice: string) => ({ mode: "subscription", invoice, payment_intent: null, metadata: { kind: "plan", store: "recurshop" } });
  const plan = (n: number) => {
    const ids = [1, 2, 3].map((k) => ({ invoice: `in_plan${pad(n)}${k}`, pi: `pi_plan${pad(n)}${k}` }));
    for (const { invoice, pi } of ids) {
      invoices.set(invoice, { id: invoice, object: "invoice", payment_intent: pi, amount_paid: 1000 });
      pays.set(pi, { amount: 1000, back: 0 });
    }
    return ids;
  };
  const p1 = plan(1);
  is("three paid instalments: not given back", await purchaseRefunded(ACCOUNT, session(p1[0].invoice)), false);
  refund(p1[1].pi, 1000);
  is("instalment 2 refunded in full closes nothing (a later instalment never does)", await purchaseRefunded(ACCOUNT, session(p1[0].invoice)), false);
  dispute(p1[2].pi, "lost");
  is("instalment 3 lost to a dispute closes nothing either", await purchaseRefunded(ACCOUNT, session(p1[0].invoice)), false);
  const charged = [...p1].reduce((sum, { pi }) => sum + (pays.get(pi)?.amount ?? 0), 0);
  const back = [...p1].reduce((sum, { pi }) => sum + (pays.get(pi)?.back ?? 0), 0);
  is("amounts reconcile on the account: charged = refunded + kept", [charged, back, charged - back], [3000, 1000, 2000]);
  refund(p1[0].pi, 400);
  is("instalment 1 partly refunded: kept", await purchaseRefunded(ACCOUNT, session(p1[0].invoice)), false);
  refund(p1[0].pi, 600);
  is("instalment 1 refunded in full: given back", await purchaseRefunded(ACCOUNT, session(p1[0].invoice)), true);
  is("read twice, the same answer", await purchaseRefunded(ACCOUNT, session(p1[0].invoice)), true);

  const p2 = plan(2);
  dispute(p2[0].pi, "needs_response");
  is("first payment disputed, still open: kept", await purchaseRefunded(ACCOUNT, session(p2[0].invoice)), false);
  dispute(p2[0].pi, "won");
  is("first payment's dispute won by the creator: kept", await purchaseRefunded(ACCOUNT, session(p2[0].invoice)), false);
  dispute(p2[0].pi, "lost");
  is("first payment's dispute lost: given back", await purchaseRefunded(ACCOUNT, session(p2[0].invoice)), true);

  part("Payment plan, unknown replies never read as given back by someone else's money");
  const p3 = plan(3);
  refund(p3[0].pi, 1000);
  invoices.set(p3[0].invoice, { id: "in_someoneelse01", object: "invoice", payment_intent: p3[0].pi });
  is("an invoice reply for another invoice decides nothing (door lets in, as documented)", await purchaseRefunded(ACCOUNT, session(p3[0].invoice)), false);
  invoices.set(p3[0].invoice, { id: p3[0].invoice, object: "invoice", payment_intent: p3[0].pi });
  foreign.add(p3[0].pi);
  is("a payment reply naming another refunded payment decides nothing", await purchaseRefunded(ACCOUNT, session(p3[0].invoice)), false);
  foreign.delete(p3[0].pi);
  is("its own reply, refunded in full: given back", await purchaseRefunded(ACCOUNT, session(p3[0].invoice)), true);

  part("Payment plan on the newer API: the invoice's payments, all of them");
  const inv = "in_planpaymentsnew";
  invoices.set(inv, { id: inv, object: "invoice" });
  pays.set("pi_planpaya000001", { amount: 500, back: 500 });
  pays.set("pi_planpayb000001", { amount: 500, back: 0 });
  const paid = (pi: string) => ({ object: "invoice_payment", invoice: inv, status: "paid", payment: { type: "payment_intent", payment_intent: pi } });
  invoicePayments.set(inv, { data: [paid("pi_planpaya000001"), paid("pi_planpayb000001")], has_more: false });
  is("one of two payments refunded: not all given back", await purchaseRefunded(ACCOUNT, session(inv)), false);
  pays.set("pi_planpayb000001", { amount: 500, back: 500 });
  invoicePayments.set(inv, { data: [paid("pi_planpaya000001"), paid("pi_planpayb000001")], has_more: true });
  is("both refunded but the list not read whole: never 'all of it'", await purchaseRefunded(ACCOUNT, session(inv)), false);
  invoicePayments.set(inv, { data: [paid("pi_planpaya000001"), paid("pi_planpayb000001")], has_more: false });
  is("both refunded, the list whole: given back", await purchaseRefunded(ACCOUNT, session(inv)), true);

  part("A dispute list Stripe does not answer whole is unknown, never 'not lost'");
  pays.set("pi_planunknown0001", { amount: 1000, back: 0, disputed: true });
  disputes.set(chargeId("pi_planunknown0001"), [{ status: "prevented" }]);
  const lost = await disputeLost(ACCOUNT, { object: "payment_intent", latest_charge: charge("pi_planunknown0001") }).then((v) => v, () => "unknown");
  is("a prevented dispute whose money does not read: unknown (throws)", lost, "unknown");
}

async function memberships(store: Store): Promise<void> {
  part("Membership: the doors go by the subscription's state");
  subscriptions.set("sub_member000001", { id: "sub_member000001", object: "subscription", status: "active" });
  is("active: open", isLive(await membershipStatus(store, "sub_member000001")), true);
  // A renewal invoice refunded leaves the subscription active: the door goes by the subscription (documented rule).
  pays.set("pi_renewal0000001", { amount: PRICE, back: 0 });
  refund("pi_renewal0000001", PRICE);
  is("a renewal refunded while the subscription stays active: still open (state-based door)", isLive(await membershipStatus(store, "sub_member000001")), true);
  const expanded = (status: string, next: number | null) => ({ id: "sub_member000002", object: "subscription", status, latest_invoice: { object: "invoice", next_payment_attempt: next } });
  is("past due with a retry scheduled: open", isLive(await membershipStatus(store, expanded("past_due", NOW + 86_400))), true);
  is("past due with no retry left: ended", isLive(await membershipStatus(store, expanded("past_due", null))), false);
  is("canceled or unpaid: ended", [isLive(await membershipStatus(store, expanded("canceled", null))), isLive(await membershipStatus(store, expanded("unpaid", null)))], [false, false]);
  subscriptions.set("sub_member000003", { id: "sub_member000003", object: "subscription" });
  is("a reply with no status: unknown, never open", await membershipStatus(store, "sub_member000003"), null);
  is("a subscription Stripe does not know: throws, never open", await membershipStatus(store, "sub_member000404").then((s) => isLive(s), () => "unknown"), "unknown");
}

async function gifts(store: Store, product: Listing): Promise<void> {
  part("Gift: paid, handed over once, receipt says what was charged");
  const g = await giveGift(store, product, 1);
  const sentBefore = emails.length;
  is("handed over", await g.deliver(), "given");
  is("held once by the recipient", await holds(store, g.to, product.id), 1);
  const sent = emails.slice(sentBefore);
  is("two emails: the recipient's and the buyer's receipt", sent.map((e) => e.to).sort(), [g.to, "buyer1@recurring.example"].sort());
  is("the receipt's amount is what was charged ($25)", sent.some((e) => e.to === "buyer1@recurring.example" && /Paid: \$25(\.00)?\n/.test(e.text)), true);
  is("replayed (thanks page + sweep): already, nothing more", await g.deliver(), "already");
  is("still held once, no new email", [await holds(store, g.to, product.id), emails.length - sentBefore], [1, 2]);

  part("Gift: partial refund keeps it, a full refund takes it back once");
  refund(g.pi, 1000);
  is("partial refund: nothing taken back", await runGifts(store), 0);
  is("still held", await holds(store, g.to, product.id), 1);
  refund(g.pi, PRICE - 1000);
  is("refunded in full: taken back", await runGifts(store), 1);
  is("no longer held, and the gift marked revoked", [await holds(store, g.to, product.id), Boolean((await readGift(g.id))?.revoked)], [0, true]);
  is("the refund read again: nothing more", await runGifts(store), 0);
  is("the delivery replayed after the refund: already (never given again)", [await g.deliver(), await holds(store, g.to, product.id)], ["already", 0]);
  const p = pays.get(g.pi)!;
  is("amounts reconcile: charged = refunded + kept", [p.amount, p.back, p.amount - p.back], [PRICE, PRICE, 0]);

  part("Gift: a dispute won keeps it, one lost takes it back");
  const w = await giveGift(store, product, 2);
  await w.deliver();
  dispute(w.pi, "won");
  is("dispute won: nothing taken back", [await runGifts(store), await holds(store, w.to, product.id)], [0, 1]);
  const l = await giveGift(store, product, 3);
  await l.deliver();
  dispute(l.pi, "lost");
  is("dispute lost: taken back", [await runGifts(store), await holds(store, l.to, product.id)], [1, 0]);
  is("the closing read again: nothing more", await runGifts(store), 0);
}

async function preorders(store: Store, book: Listing): Promise<void> {
  const sid = store.statsId as string;
  await redis.pipeline([["SADD", `nl:wl:${sid}:soon`, book.id]]);
  await setExpectedDay(store, book.id, new Date((NOW + 30 * 86_400) * 1000).toISOString().slice(0, 10));

  part("Pre-order while coming soon: written once, receipted once");
  const s1 = preSession(book, 1);
  const before = emails.length;
  is("receipted", await confirmPreorder(store, s1 as never, book, deps), "sent");
  is("replayed: still one record", [await confirmPreorder(store, s1 as never, book, deps), await waitingCount(store, book.id)], ["sent", 1]);
  const keys = new Set(emails.slice(before).map((e) => e.key));
  is("the replay's receipt carries the same once-only key (the provider sends it once)", keys.size, 1);
  is("the receipt's amount is what was charged", emails.slice(before).every((e) => /\$25(\.00)?/.test(e.text)), true);

  const s2 = preSession(book, 2);
  const s3 = preSession(book, 3);
  const s4 = preSession(book, 4);
  for (const s of [s2, s3, s4]) await confirmPreorder(store, s as never, book, deps);
  is("four waiting", await waitingCount(store, book.id), 4);

  part("Pre-order refunded before release: never handed over");
  refund(s2.payment_intent, PRICE);
  is("the refund job marks it refunded", await runPre(store), 1);
  is("and it no longer waits", await waitingCount(store, book.id), 3);
  // s3: refunded on Stripe but the refund job has not read it yet; the release reads the payment itself.
  pays.set(s3.payment_intent, { amount: PRICE, back: PRICE });
  // s4: partly refunded before release: handed over, as it was paid for in part.
  refund(s4.payment_intent, 500);

  part("Released: the paid ones handed over once");
  await redis.pipeline([["SREM", `nl:wl:${sid}:soon`, book.id]]);
  await queueRelease(store, book.id);
  const store2 = (await storeForEmail(OWNER))!;
  const release = () => runPreorderReleases(async () => store2, async () => book, () => deps, Date.now() + 30_000);
  is("two handed over (s1 and the partly refunded s4)", await release(), 2);
  is("held: s1 yes, s2 no, s3 no, s4 yes", [await holds(store2, s1.customer_details.email, book.id), await holds(store2, s2.customer_details.email, book.id), await holds(store2, s3.customer_details.email, book.id), await holds(store2, s4.customer_details.email, book.id)], [1, 0, 0, 1]);
  is("s3 marked refunded by the release's own read", Boolean((await readPreorder(store2, book.id, s3.id))?.revoked), true);
  const out = emails.filter((e) => e.subject?.startsWith("It is out"));
  is("one 'it is out' email per buyer handed over", out.map((e) => e.to).sort(), [s1.customer_details.email, s4.customer_details.email].sort());
  is("released again: nothing more", await release(), 0);
  is("still one 'it is out' email each", emails.filter((e) => e.subject?.startsWith("It is out")).length, 2);

  part("Pre-order refunded or lost after release: taken back once");
  refund(s1.payment_intent, PRICE);
  dispute(s4.payment_intent, "lost");
  is("both taken back", await runPre(store2), 2);
  is("held by neither", [await holds(store2, s1.customer_details.email, book.id), await holds(store2, s4.customer_details.email, book.id)], [0, 0]);
  is("read again: nothing more", await runPre(store2), 0);
  is("a confirmation replayed after the refund hands nothing back", [await confirmPreorder(store2, s1 as never, book, deps), await holds(store2, s1.customer_details.email, book.id)], ["skip", 0]);
}

// ------------------------------------------------------------------ Was RED on main (f964dbd9): fixed in this pull request

async function redRefundedBeforeConfirm(store: Store, giftable: Listing, book: Listing): Promise<void> {
  // Was RED on main: MM-E2E-RG-1 — a gift refunded in full before its confirmation is handed over and never taken back.
  part("Was RED: MM-E2E-RG-1: gift refunded before it is confirmed (refund job ran first)");
  const g = await giveGift(store, giftable, 9);
  refund(g.pi, PRICE);
  // The sweep reads refunds first (lib/checkout-sweep.ts, sweepStore), then confirms: the gift has no payment record
  // yet, so the refund is marked read with nothing to take back.
  await runGifts(store);
  is("confirmed after the refund: nothing given, the confirmation kept as done", await g.deliver(), "already");
  await runGifts(store);
  is("a gift refunded in full is not held by its recipient", await holds(store, g.to, giftable.id), 0);

  // Was RED on main: MM-E2E-RG-2 — the same for a pre-order paid after the product went on sale (handed over at once).
  part("Was RED: MM-E2E-RG-2: pre-order of a product on sale, refunded before it is confirmed");
  const s = preSession(book, 9);
  refund(s.payment_intent, PRICE);
  await runPre(store);
  is("confirmed after the refund: never handed over", await confirmPreorder(store, s as never, book, deps), "skip");
  await runPre(store);
  is("a pre-order refunded in full is not held by its buyer", await holds(store, s.customer_details.email, book.id), 0);
}

// MM-E2E-RG-3 (LEVE, not fixed here): the release job (lib/preorders.ts releaseJob) judges a pre-order by the payment
// reply without checking it answers for the payment asked for; the same lines are being changed by open PR #4072, so
// the own-reply check waits for it to merge.

async function main(): Promise<void> {
  const { store, giftable, book } = await world();
  await paymentPlans();
  await memberships(store);
  await gifts(store, giftable);
  await preorders(store, book);
  await redRefundedBeforeConfirm((await storeForEmail(OWNER))!, giftable, book);
  done();
}

void main();
