/**
 * C4-36 (B), inbox C4-41 (d): a kept reading brought up to date from Stripe's
 * events (lib/sales-events.ts) makes the same numbers as a whole reading,
 * step by step, for a synthetic history with a refund pending then failed, a
 * dispute that changes status, a sale created before the kept reading and
 * paid after it, an upsell, a paid invoice and a PayPal sale and refund.
 *
 * What fails here:
 *   - any number different from the whole reading's at any step;
 *   - an event of a type that touches the numbers and is not read being
 *     skipped instead of sending the caller to the whole reading;
 *   - the numbers depending on the order the events come in.
 */
import { isDeepStrictEqual } from "node:util";
import { applySalesEvents, SALES_EVENT_TYPE_LIST, type StripeEvent } from "@/lib/sales-events";
import { compactSalesInputs } from "@/lib/sales-inputs";
import { disputeOfRow, refundOfRow, renewalsFromInvoices, saleOfCheckout, saleOfUpsell, salesFromInputs, type RefundRow, type Sale, type SalesInputs } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const T0 = Date.UTC(2031, 5, 20, 9);
const store = { handle: "kiln", previousHandles: [], sid: "s1", currency: "usd", stripeAccountId: "acct_1", paypalSeller: null, statsId: "a".repeat(32), catalog: { items: [], head: [], inline: [] } } as unknown as Store;
const handles = new Set(["kiln"]);
const sec = (ms: number) => Math.floor(ms / 1000);

// The account's objects, as Stripe would answer them at a moment.
type World = { checkouts: Map<string, Record<string, unknown>>; upsells: Map<string, Record<string, unknown>>; refunds: Map<string, Record<string, unknown>>; disputes: Map<string, Record<string, unknown>>; invoices: Map<string, Record<string, unknown>>; paypalSales: Sale[]; paypalRefunds: RefundRow[] };
const world: World = { checkouts: new Map(), upsells: new Map(), refunds: new Map(), disputes: new Map(), invoices: new Map(), paypalSales: [], paypalRefunds: [] };
const events: StripeEvent[] = [];
let n = 0;
const emit = (type: string, object: Record<string, unknown>, at: number) => events.push({ id: `evt_${String(++n).padStart(6, "0")}`, type, created: sec(at), data: { object: structuredClone(object) } });

const checkout = (id: string, created: number, cents: number, meta: Record<string, string> = {}, paid = "paid") => ({
  id, object: "checkout.session", status: "complete", payment_status: paid, amount_total: cents, currency: "usd", created: sec(created), payment_intent: `pi_${id}`,
  customer_details: { email: `${id}@example.com`, address: { country: "US" } }, metadata: { store: "kiln", product: "p1", ...meta },
});
const refund = (id: string, created: number, cents: number, pi: string, status: string) => ({ id, object: "refund", status, amount: cents, currency: "usd", created: sec(created), payment_intent: pi });
const dispute = (id: string, created: number, cents: number, pi: string, status: string) => ({ id, object: "dispute", status, amount: cents, currency: "usd", created: sec(created), payment_intent: pi });
const invoice = (id: string, created: number, cents: number, reason: string) => ({ id, object: "invoice", status: "paid", amount_paid: cents, currency: "usd", billing_reason: reason, created: sec(created), parent: { subscription_details: { metadata: { store: "kiln", product: "club" } } } });

/** The whole reading at `now`, as readSalesInputs makes it from what Stripe and PayPal hold then. */
function whole(now: number): SalesInputs {
  const salesFrom = (sec(now) - 180 * 86_400) * 1000;
  const from = (sec(now) - 90 * 86_400) * 1000;
  const read = [
    ...world.paypalSales.filter((s) => s.created >= salesFrom),
    ...[...world.checkouts.values()].map((c) => saleOfCheckout(c, handles)).filter((s): s is Sale => Boolean(s) && s!.created >= salesFrom),
    ...[...world.upsells.values()].map((p) => saleOfUpsell(p, handles)).filter((s): s is Sale => Boolean(s) && s!.created >= salesFrom),
  ].sort((a, b) => b.created - a.created);
  const refunds = [...[...world.refunds.values()].map(refundOfRow).filter((r): r is RefundRow => Boolean(r)), ...world.paypalRefunds].filter((r) => r.created >= from).sort((a, b) => b.created - a.created);
  const disputes = [...world.disputes.values()].map(disputeOfRow).filter((d) => d && d.created >= from).sort((a, b) => b!.created - a!.created) as NonNullable<ReturnType<typeof disputeOfRow>>[];
  const invoices = [...world.invoices.values()].filter((i) => (i.created as number) * 1000 >= from).sort((a, b) => (b.created as number) - (a.created as number));
  return { read, readPartial: false, renewalRead: renewalsFromInvoices(store, invoices, false, now), refundRead: { rows: refunds, partial: false }, disputeRead: { rows: disputes, partial: false } };
}
const numbers = (inputs: SalesInputs, now: number) => salesFromInputs(store, inputs, now);
const same = (a: SalesInputs, b: SalesInputs, now: number) => isDeepStrictEqual(numbers(a, now), numbers(b, now));

part("The kept reading at T0");
for (let i = 0; i < 12; i += 1) world.checkouts.set(`cs_old${i}`, checkout(`cs_old${i}`, T0 - (i * 7 + 1) * DAY, 4_900, i % 3 ? {} : { code: "SAVE" }));
world.refunds.set("re_a", refund("re_a", T0 - 2 * DAY, 4_900, "pi_cs_old0", "succeeded"));
world.disputes.set("dp_a", dispute("dp_a", T0 - 3 * DAY, 4_900, "pi_cs_old1", "under_review"));
world.invoices.set("in_a", invoice("in_a", T0 - 10 * DAY, 1_900, "subscription_cycle"));
// A checkout opened before the kept reading, its payment still on its way: not a sale yet.
world.checkouts.set("cs_late", checkout("cs_late", T0 - 600_000, 9_900, {}, "unpaid"));
const kept = compactSalesInputs(store, whole(T0), T0);
is("kept compact, the same numbers as the whole reading at T0", same(kept, whole(T0), T0), true);

part("Changes after T0, each step the same as a whole reading");
let at = T0;
const step = (minutes: number, change: () => void) => {
  at += minutes * 60_000;
  change();
  const brought = applySalesEvents(store, kept, events, { sales: world.paypalSales, refunds: world.paypalRefunds }, handles, at);
  return brought !== null && same(brought, whole(at), at);
};
is("a new sale", step(5, () => { const c = checkout("cs_new1", at, 2_500); world.checkouts.set("cs_new1", c); emit("checkout.session.completed", c, at); }), true);
is("the checkout opened before T0 paid after it", step(5, () => { const c = { ...checkout("cs_late", T0 - 600_000, 9_900) }; world.checkouts.set("cs_late", c); emit("checkout.session.async_payment_succeeded", c, at); }), true);
is("a refund, pending", step(5, () => { const r = refund("re_b", at, 2_500, "pi_cs_new1", "pending"); world.refunds.set("re_b", r); emit("refund.created", r, at); }), true);
is("that refund failed: it leaves the numbers", step(5, () => { const r = refund("re_b", at - 300_000, 2_500, "pi_cs_new1", "failed"); world.refunds.set("re_b", r); emit("refund.failed", r, at); }), true);
is("the dispute under review is won: it leaves the numbers", step(5, () => { const d = dispute("dp_a", T0 - 3 * DAY, 4_900, "pi_cs_old1", "won"); world.disputes.set("dp_a", d); emit("charge.dispute.closed", d, at); }), true);
is("a new dispute, then lost", step(5, () => { const d = dispute("dp_b", at, 4_900, "pi_cs_old2", "needs_response"); world.disputes.set("dp_b", d); emit("charge.dispute.created", d, at); world.disputes.set("dp_b", { ...d, status: "lost" }); emit("charge.dispute.closed", { ...d, status: "lost" }, at + 1_000); }), true);
is("an upsell taken in one click", step(5, () => { const p = { id: "pi_up1", object: "payment_intent", status: "succeeded", amount: 1_500, currency: "usd", created: sec(at), metadata: { kind: "upsell", store: "kiln", product: "p2" }, receipt_email: "cs_new1@example.com" }; world.upsells.set("pi_up1", p); emit("payment_intent.succeeded", p, at); }), true);
is("a renewal paid", step(5, () => { const i = invoice("in_b", at, 1_900, "subscription_cycle"); world.invoices.set("in_b", i); emit("invoice.paid", i, at); }), true);
is("a PayPal sale and its refund", step(5, () => {
  world.paypalSales.push({ created: at, product: "p1", cents: 3_000, currency: "usd", row: { id: "paypal:ORDER9", object: "paypal.order", metadata: { store: "kiln", paid_with: "paypal" } }, upsell: false, source: "", medium: "", campaign: "", first: "", content: "", country: "", paymentIntent: "paypal:ORDER9" });
  world.paypalRefunds.push({ created: at, cents: 3_000, currency: "usd", paymentIntent: "paypal:ORDER9", id: "paypal-refund:CAP9" });
}), true);
is("another store's checkout changes nothing", step(5, () => { emit("checkout.session.completed", checkout("cs_other", at, 7_700, { store: "elsewhere" }), at); }), true);
is("a day later, the window moves on the same way", step(24 * 60, () => {}), true);

part("Order and what it cannot place");
const shuffled = [...events].reverse();
const inOrder = applySalesEvents(store, kept, events, { sales: world.paypalSales, refunds: world.paypalRefunds }, handles, at);
const reversed = applySalesEvents(store, kept, shuffled, { sales: world.paypalSales, refunds: world.paypalRefunds }, handles, at);
is("the events in any order give the same numbers (applied oldest first)", inOrder !== null && reversed !== null && same(inOrder, reversed, at), true);
is("an event of a type that touches the numbers and is not read: the whole reading", applySalesEvents(store, kept, [...events, { id: "evt_x", type: "charge.dispute.funds_mystery", created: sec(at), data: { object: { id: "dp_c" } } }], { sales: [], refunds: [] }, handles, at), null);
is("an event without an object: the whole reading", applySalesEvents(store, kept, [{ id: "evt_y", type: "refund.updated", created: sec(at), data: {} as never }], { sales: [], refunds: [] }, handles, at), null);
is("an event of another family is passed over", applySalesEvents(store, kept, [{ id: "evt_z", type: "customer.updated", created: sec(at), data: { object: { id: "cus_1" } } }], { sales: [], refunds: [] }, handles, at) !== null, true);
is("the types asked of Stripe are the types read", new Set(SALES_EVENT_TYPE_LIST).size === SALES_EVENT_TYPE_LIST.length && SALES_EVENT_TYPE_LIST.includes("refund.failed") && SALES_EVENT_TYPE_LIST.includes("charge.dispute.closed"), true);

done();
