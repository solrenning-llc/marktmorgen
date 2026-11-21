/**
 * A Stripe event of this store whose amount or money cannot be read is never
 * sent to the creator's endpoint as a sale, a refund or a dispute of $0, or as
 * one in US dollars (rule 24: unknown fails, never zero). Before, fromStripe
 * (lib/webhooks.ts) read a missing `amount_total`, `amount` or
 * `amount_refunded` as 0 and a missing `currency` as "usd" and sent it, once
 * and for good (the event's once-only mark): the creator's books, fed by the
 * endpoint, recorded a sale of nothing. Now such an event waits, as one whose
 * shape our code does not know, and the events before it are sent as they were.
 * Synthetic Stripe answers only; the endpoint resolves to a private address.
 */
import { addEndpoint, recentMessages, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_amount_unknown_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_AmountUnknown01";
const HANDLE = "amount-unknown-shop";
let events: unknown[] = [];
const intents: Record<string, Record<string, string>> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== account) throw new Error(`unexpected synthetic operation ${url}`);
  if (url.pathname === "/v1/events") return Response.json({ data: events, has_more: false });
  const intent = url.pathname.match(/^\/v1\/payment_intents\/(pi_\w+)$/)?.[1];
  if (intent && intents[intent]) return Response.json({ id: intent, metadata: intents[intent] });
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
}) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const logged = console.error;
console.error = (...args: unknown[]) => {
  const first = String(args[0]);
  if (first.startsWith("a webhook delivery failed") || first.startsWith("OUR CODE FAILED on a Stripe event")) return;
  logged(...args);
};

async function setup(listen: string[]) {
  redis.clear();
  await claimHandle("amount-unknown@example.com", HANDLE, "Amount Unknown", "");
  await ensureStatsId("amount-unknown@example.com");
  await setStripeAccount("amount-unknown@example.com", account);
  await setSubscription("amount-unknown@example.com", { customerId: "cus_AmountUnknown01", subscriptionId: "sub_AmountUnknownPlan01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail("amount-unknown@example.com"))!;
  is("an endpoint listening is kept", (await addEndpoint(store, "https://hooks.example.net/in", listen)).ok, true);
  return store;
}

const without = (row: Record<string, unknown>, change: Record<string, unknown>) => {
  const out = { ...row };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
};

async function main() {
  part("A checkout");
  const session = (id: string) => ({ id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", amount_total: 4900, currency: "eur", total_details: { amount_discount: 0 }, customer_details: { email: "buyer@example.com", name: "Buyer" }, metadata: { store: HANDLE, product: "p_course" } });
  const checkoutCases: [string, Record<string, unknown>][] = [
    ["its amount missing", { amount_total: undefined }],
    ["its amount null", { amount_total: null }],
    ["its amount as text", { amount_total: "4900" }],
    ["its money missing", { currency: undefined }],
  ];
  for (const [what, change] of checkoutCases) {
    const store = await setup(["sale.completed"]);
    events = [
      { id: "evt_Bad01", type: "checkout.session.completed", created: 1_790_000_100, data: { object: without(session("cs_bad01"), change) } },
      { id: "evt_Good01", type: "checkout.session.completed", created: 1_790_000_000, data: { object: session("cs_good01") } },
    ];
    await watchStripe(Date.now() + 10_000);
    const sent = (await recentMessages(store, "sale.completed", 10)).map((m) => m.data as Record<string, unknown>);
    is(`${what}: the whole one before it is sent as it was, and it is not sent at $0 or in dollars`, sent.map((d) => [d.checkout_session, d.amount_cents, d.currency]), [["cs_good01", 4900, "eur"]]);
  }

  part("A one-click offer");
  const offer = (id: string) => ({ id, object: "payment_intent", status: "succeeded", amount: 2900, currency: "eur", receipt_email: "buyer@example.com", metadata: { store: HANDLE, kind: "upsell", product: "p_offer" } });
  for (const [what, change] of [["its amount missing", { amount: undefined }], ["its money missing", { currency: undefined }]] as [string, Record<string, unknown>][]) {
    const store = await setup(["sale.completed"]);
    events = [
      { id: "evt_BadOffer", type: "payment_intent.succeeded", created: 1_790_001_100, data: { object: without(offer("pi_BadOffer"), change) } },
      { id: "evt_GoodOffer", type: "payment_intent.succeeded", created: 1_790_001_000, data: { object: offer("pi_GoodOffer") } },
    ];
    await watchStripe(Date.now() + 10_000);
    const sent = (await recentMessages(store, "sale.completed", 10)).map((m) => m.data as Record<string, unknown>);
    is(`${what}: only the whole one is sent`, sent.map((d) => [d.payment_intent, d.amount_cents, d.currency]), [["pi_GoodOffer", 2900, "eur"]]);
  }

  part("A refund");
  const refund = (id: string) => ({ id, object: "charge", payment_intent: null, amount: 4900, amount_refunded: 1000, refunded: false, currency: "eur", metadata: { store: HANDLE, product: "p_course" } });
  for (const [what, change] of [["its amount refunded missing", { amount_refunded: undefined }], ["its amount missing", { amount: undefined }], ["its money missing", { currency: undefined }]] as [string, Record<string, unknown>][]) {
    const store = await setup(["refund.issued"]);
    events = [
      { id: "evt_BadRefund", type: "charge.refunded", created: 1_790_002_100, data: { object: without(refund("ch_BadRefund"), change), previous_attributes: { amount_refunded: 0 } } },
      { id: "evt_GoodRefund", type: "charge.refunded", created: 1_790_002_000, data: { object: refund("ch_GoodRefund"), previous_attributes: { amount_refunded: 0 } } },
    ];
    await watchStripe(Date.now() + 10_000);
    const sent = (await recentMessages(store, "refund.issued", 10)).map((m) => m.data as Record<string, unknown>);
    is(`${what}: only the whole one is sent`, sent.map((d) => [d.charge, d.amount_refunded_cents, d.amount_cents, d.currency]), [["ch_GoodRefund", 1000, 4900, "eur"]]);
  }

  part("A dispute");
  intents.pi_Disputed = { store: HANDLE, product: "p_course" };
  const dispute = (id: string) => ({ id, object: "dispute", charge: `ch_${id}`, payment_intent: "pi_Disputed", amount: 4900, currency: "eur", reason: "fraudulent", status: "needs_response", evidence_details: { due_by: 1_791_000_000 }, metadata: {} });
  for (const [what, change] of [["its amount missing", { amount: undefined }], ["its money missing", { currency: undefined }]] as [string, Record<string, unknown>][]) {
    const store = await setup(["dispute.opened"]);
    events = [
      { id: "evt_BadDispute", type: "charge.dispute.created", created: 1_790_003_100, data: { object: without(dispute("dp_Bad"), change) } },
      { id: "evt_GoodDispute", type: "charge.dispute.created", created: 1_790_003_000, data: { object: dispute("dp_Good") } },
    ];
    await watchStripe(Date.now() + 10_000);
    const sent = (await recentMessages(store, "dispute.opened", 10)).map((m) => m.data as Record<string, unknown>);
    is(`${what}: only the whole one is sent`, sent.map((d) => [d.dispute, d.amount_cents, d.currency]), [["dp_Good", 4900, "eur"]]);
  }
  done();
}

void main();
