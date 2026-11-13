/**
 * The MEDIUM on #4408 (Claude 2, review 6862531714, 13/11/2026): a gift taken back before its first confirmation could
 * stay with its recipient. The gift's payment index (nl:gift:pi:) was written only after the grant, and the refund
 * pass finds a gift only through it:
 *
 *   1. a first deliverGift run read the payment as kept, wrote the grant, then failed before the index; the buyer was
 *      refunded in full; the pass found no gift for the refund and marked it read; the next run read the refund and
 *      marked the gift revoked, but never took back what the first run granted: revoked on record, still held;
 *   2. a full refund after the payment read, met by the pass before the index: the gift was given for good.
 *
 * Now the index is written before the payment is read (as pre-orders do), the "given back" branch takes back what an
 * earlier run of this gift granted (its course first, then its purchase record, only the record this gift wrote), and
 * the gift is read again before "given" is saved, so a revocation in between is never written over.
 * Synthetic Stripe account, in-memory Redis; no network, no real email.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, readGift, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { grantImported, importedFor } from "@/lib/imported-purchases";
import { advance, store as redis } from "./redis-stub";
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
/** Payments whose read fails (Stripe answers 500). */
const unreadable = new Set<string>();
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
    if (unreadable.has(intent)) return answer({ error: { message: "down" } }, 500);
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

const runGifts = (store: Store) => revokeRefundedGifts(store, Date.now() + 60_000, drop);


async function main(): Promise<void> {
  const { store, giftable } = await world();

  part("Path 1: the first run fails after the grant, the buyer is refunded in full, then the next run");
  const one = await giveGift(store, giftable, 1);
  const failing = () => deliverGift({ ...giftArgs(store, giftable, one), recordStart: async () => { throw new Error("Redis went away"); } });
  let threw = false;
  try { await failing(); } catch { threw = true; }
  is("control: the first run failed after the grant", [threw, await holds(store, one.to, giftable.id)], [true, 1]);
  refund(one.pi, PRICE);
  await runGifts(store);
  // The failed run's giving mark runs out (300 s) before the sweep or the thank-you page tries again.
  advance(301_000);
  const next = await deliverGift(giftArgs(store, giftable, one));
  is("the next run answers that it is done", next, "already");
  is("the refunded gift is no longer held by its recipient", await holds(store, one.to, giftable.id), 0);
  is("and its record says it was taken back, never given", [Boolean((await readGift(one.id))?.revoked), Boolean((await readGift(one.id))?.given)], [true, false]);

  part("Path 2: a full refund met by the refund pass while the first run is still giving");
  const two = await giveGift(store, giftable, 2);
  const mailsBefore = emails.filter((m) => m.to === two.to).length;
  const racing = await deliverGift({
    ...giftArgs(store, giftable, two),
    recordStart: async () => {
      // Between the grant and "given": the buyer is refunded and the pass runs.
      refund(two.pi, PRICE);
      await runGifts(store);
    },
  });
  is("the run that was giving does not write \"given\" over the revocation", [Boolean((await readGift(two.id))?.revoked), Boolean((await readGift(two.id))?.given)], [true, false]);
  is("the refunded gift is not held", await holds(store, two.to, giftable.id), 0);
  is("and its recipient is not emailed a gift that was taken back", [racing, emails.filter((m) => m.to === two.to).length - mailsBefore], ["already", 0]);

  part("Control: a purchase the recipient holds another way is never taken by the gift's refund");
  const three = await giveGift(store, giftable, 3);
  await grantImported(store.statsId!, "paypal:PAYPALORDER0003", [{ email: three.to, productId: giftable.id, items: null, option: null }], NOW - 45_000, store.sid);
  refund(three.pi, PRICE);
  is("the refunded gift is not handed over", await deliverGift(giftArgs(store, giftable, three)), "already");
  is("the PayPal purchase stays theirs", await holds(store, three.to, giftable.id), 1);
  done();
}

/** What confirmGift (lib/purchase-email.ts) passes deliverGift for a gift made by giveGift. */
function giftArgs(store: Store, product: Listing, gift: { to: string; pi: string; id: string }) {
  const session = { id: `cs_test_gift${gift.pi.slice(7)}abcd`, created: NOW - 40_000, amount_total: PRICE, currency: "usd", payment_intent: gift.pi, metadata: { store: "recurshop", product: product.id, gift: gift.id }, customer_details: { email: "buyer@recurring.example" } };
  return { store, session: session as never, product, base: deps.base, from: deps.from, recordStart: async () => {}, dropStart: drop, ordersLink: async () => null };
}

void main();
