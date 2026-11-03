/**
 * 630 [HN6](18) unit 1: two more webhook events read from the creator's own
 * Stripe account. membership.changed, when a membership moves to another
 * price or quantity; dispute.opened, when a buyer disputes a payment the
 * store's checkout made. Synthetic Stripe answers only; the endpoint's name
 * resolves to a private address, so nothing leaves this machine.
 */
import { readFileSync } from "node:fs";
import { WEBHOOK_EVENTS, addEndpoint, isWebhookEvent, recentMessages, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_more_events_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_MoreEvents01";
const HANDLE = "more-events-shop";
let events: unknown[] = [];
const intents: Record<string, Record<string, string>> = {};
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== account) throw new Error(`unexpected synthetic operation ${url}`);
  asked.push(url.pathname);
  if (url.pathname === "/v1/events") return Response.json({ data: events, has_more: false });
  const intent = url.pathname.match(/^\/v1\/payment_intents\/(pi_\w+)$/)?.[1];
  if (intent && intents[intent]) return Response.json({ id: intent, metadata: intents[intent] });
  return Response.json({ error: { message: "No such object" } }, { status: 404 });
}) as typeof fetch;
// The endpoint's name resolves to a private address: every try is refused before any socket opens.
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
// The memory store cannot run the delivery claim's script; the try that fails here is not what is checked.
const logged = console.error;
console.error = (...args: unknown[]) => (String(args[0]).startsWith("a webhook delivery failed") ? undefined : logged(...args));

const item = (price: string, amount: number, interval: string, quantity = 1) => ({ data: [{ id: "si_1", quantity, price: { id: price, unit_amount: amount, recurring: { interval, interval_count: 1 } } }] });
const sub = (id: string, extra: Record<string, unknown>) => ({ id, object: "subscription", metadata: { store: HANDLE, product: "p_member", option: "gold" }, ...extra });

async function setup(listen: string[]) {
  redis.clear();
  await claimHandle("more-events@example.com", HANDLE, "More Events", "");
  await ensureStatsId("more-events@example.com");
  await setStripeAccount("more-events@example.com", account);
  const store = (await storeForEmail("more-events@example.com"))!;
  is("an endpoint listening for them is kept", (await addEndpoint(store, "https://hooks.example.net/in", listen)).ok, true);
  asked.length = 0;
  return store;
}

async function main() {
  part("The two events");
  is("both are events a store can listen for", ["membership.changed", "dispute.opened"].every(isWebhookEvent), true);
  is("the older events keep their place", WEBHOOK_EVENTS.slice(0, 9), ["sale.completed", "membership.started", "membership.canceled", "lead.captured", "list.joined", "call.booked", "call.moved", "refund.issued", "sequence.step"]);
  const editor = readFileSync("components/webhook-editor.tsx", "utf8");
  is("the studio lists both, with what each means", editor.includes('key: "membership.changed", label: "Membership changed"') && editor.includes('key: "dispute.opened", label: "Dispute opened"'), true);

  part("membership.changed");
  let store = await setup(["membership.changed"]);
  events = [
    { id: "evt_Change01", type: "customer.subscription.updated", created: 1_790_000_000, data: { object: sub("sub_A", { items: item("price_year", 69000, "year") }), previous_attributes: { items: item("price_month", 6900, "month") } } },
    { id: "evt_Change02", type: "customer.subscription.updated", created: 1_790_000_100, data: { object: sub("sub_B", { items: item("price_month", 6900, "month", 3) }), previous_attributes: { items: item("price_month", 6900, "month", 1) } } },
    { id: "evt_NoChange", type: "customer.subscription.updated", created: 1_790_000_200, data: { object: sub("sub_C", { items: item("price_month", 6900, "month") }), previous_attributes: { items: item("price_month", 6900, "month") } } },
    { id: "evt_Status", type: "customer.subscription.updated", created: 1_790_000_300, data: { object: sub("sub_D", { status: "past_due" }), previous_attributes: { status: "active" } } },
    { id: "evt_Other", type: "customer.subscription.updated", created: 1_790_000_400, data: { object: { ...sub("sub_E", { items: item("price_b", 1, "month") }), metadata: { store: "someone-else" } }, previous_attributes: { items: item("price_a", 2, "month") } } },
    { id: "evt_Plan", type: "customer.subscription.updated", created: 1_790_000_500, data: { object: { ...sub("sub_F", { items: item("price_b", 1, "month") }), metadata: { store: HANDLE, kind: "plan" } }, previous_attributes: { items: item("price_a", 2, "month") } } },
  ];
  await watchStripe(Date.now() + 10_000);
  let sent = await recentMessages(store, "membership.changed", 10);
  is("a price change and a quantity change, each said once; nothing else", sent.map((m) => (m.data as { subscription: string }).subscription).sort(), ["sub_A", "sub_B"]);
  const a = sent.find((m) => (m.data as { subscription: string }).subscription === "sub_A")!.data as Record<string, unknown>;
  is("it says from what to what", [a.from, a.to], [
    { price: "price_month", amount_cents: 6900, interval: "month", interval_count: 1, quantity: 1 },
    { price: "price_year", amount_cents: 69000, interval: "year", interval_count: 1, quantity: 1 },
  ]);
  is("with the product, the option and when", [(a.product as { id: string }).id, a.option, a.changed_at], ["p_member", "gold", new Date(1_790_000_000_000).toISOString()]);
  is("no extra Stripe request for it", asked.filter((p) => p !== "/v1/events"), []);
  await watchStripe(Date.now() + 10_000);
  is("noticed again, still sent once", (await recentMessages(store, "membership.changed", 10)).length, 2);

  part("A change that also sets an end is both");
  store = await setup(["membership.changed", "membership.canceled"]);
  events = [{ id: "evt_Both", type: "customer.subscription.updated", created: 1_790_001_000, data: { object: sub("sub_G", { items: item("price_low", 900, "month"), cancel_at_period_end: true, current_period_end: 1_792_000_000 }), previous_attributes: { items: item("price_high", 1900, "month"), cancel_at_period_end: false } } }];
  await watchStripe(Date.now() + 10_000);
  is("changed and ending, each its own event", [(await recentMessages(store, "membership.changed")).length, (await recentMessages(store, "membership.canceled")).length], [1, 1]);

  part("dispute.opened");
  store = await setup(["dispute.opened"]);
  intents.pi_Mine = { store: HANDLE, product: "p_course", option: "full" };
  intents.pi_Theirs = { store: "someone-else" };
  const dispute = (id: string, intent: string | null) => ({ id, object: "dispute", charge: `ch_${id}`, payment_intent: intent, amount: 4900, currency: "usd", reason: "fraudulent", status: "needs_response", evidence_details: { due_by: 1_791_000_000 }, metadata: {} });
  events = [
    { id: "evt_Disp1", type: "charge.dispute.created", created: 1_790_002_000, data: { object: dispute("dp_1", "pi_Mine") } },
    { id: "evt_Disp2", type: "charge.dispute.created", created: 1_790_002_100, data: { object: dispute("dp_2", "pi_Theirs") } },
    { id: "evt_Disp3", type: "charge.dispute.created", created: 1_790_002_200, data: { object: dispute("dp_3", null) } },
    { id: "evt_Disp4", type: "charge.dispute.created", created: 1_790_002_300, data: { object: dispute("dp_4", "pi_Gone") } },
  ];
  await watchStripe(Date.now() + 10_000);
  sent = await recentMessages(store, "dispute.opened", 10);
  is("only the dispute of this store's own checkout", sent.map((m) => (m.data as { dispute: string }).dispute), ["dp_1"]);
  const d = sent[0].data as Record<string, unknown>;
  is("what it says", [d.charge, d.payment_intent, (d.product as { id: string }).id, d.option, d.amount_cents, d.currency, d.reason, d.status, d.evidence_due_by, d.opened_at], ["ch_dp_1", "pi_Mine", "p_course", "full", 4900, "usd", "fraudulent", "needs_response", new Date(1_791_000_000_000).toISOString(), new Date(1_790_002_000_000).toISOString()]);
  is("no buyer's address or name in it", "buyer" in d || /@/.test(JSON.stringify(d)), false);
  is("each payment asked once; one without a payment not asked", asked.filter((p) => p.startsWith("/v1/payment_intents/")).sort(), ["/v1/payment_intents/pi_Gone", "/v1/payment_intents/pi_Mine", "/v1/payment_intents/pi_Theirs"]);

  part("Disputes have a budget of their own, bounded");
  store = await setup(["dispute.opened", "refund.issued"]);
  const refunds = Array.from({ length: 12 }, (_, i) => ({ id: `evt_Ref${i}`, type: "charge.refunded", created: 1_790_003_000 + i, data: { object: { id: `ch_r${i}`, payment_intent: `pi_Ref${i}`, amount_refunded: 100, amount: 100, refunded: true, currency: "usd", metadata: {} } } }));
  const disputes = Array.from({ length: 11 }, (_, i) => ({ id: `evt_Many${i}`, type: "charge.dispute.created", created: 1_790_004_000 + i, data: { object: dispute(`dm_${i}`, "pi_Mine") } }));
  events = [...disputes, ...refunds].reverse();
  const quiet = console.error;
  const said: string[] = [];
  console.error = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  try {
    await watchStripe(Date.now() + 10_000);
  } finally {
    console.error = quiet;
  }
  const many = await recentMessages(store, "dispute.opened", 10);
  is("refunds using up their lookups leave the disputes read", many.length >= 10, true);
  is("past ten disputes in one run, said in the log, never silently", said.some((line) => line.includes("more disputes in one run")), true);
  is("Stripe asked at most 10 + 10 times about payments", asked.filter((p) => p.startsWith("/v1/payment_intents/")).length <= 20, true);

  part("Watching starts for a store that listens only for these");
  for (const only of ["membership.changed", "dispute.opened"]) {
    await setup([only]);
    events = [];
    is(`${only} alone has the account read`, (await watchStripe(Date.now() + 10_000)).stores, 1);
  }
  done();
}

void main();
