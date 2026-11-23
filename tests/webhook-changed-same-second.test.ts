/**
 * Issue #4004 (Codex P, webhooks): membership.changed was made once per seed of the subscription, the event's second,
 * and the target price and quantity. Stripe's `created` is in whole seconds, so A -> B, B -> A, A -> B on one
 * subscription in the same second gave the first and the third the same seed, and the third was taken as already
 * sent: a receiver that applied B -> A stayed on A while the membership was on B.
 *
 * Each Stripe event is its own change: the seed carries the Stripe event's id, so a retry of one event is still
 * sent once, and three changes are three messages. Synthetic Stripe answers only; nothing leaves this machine.
 */
import { WEBHOOK_EVENTS, addEndpoint, isWebhookEvent, recentMessages, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_same_second_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_SameSecond01";
const HANDLE = "same-second-shop";
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
  // As Stripe answers an object it does not have: resource_missing (lib/webhooks.ts passes only that over).
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
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
  await claimHandle("same-second@example.com", HANDLE, "Same Second", "");
  await ensureStatsId("same-second@example.com");
  await setStripeAccount("same-second@example.com", account);
  // A paid plan, so its messages are kept: a store whose month has no webhook deliveries keeps none (lib/webhooks.ts, emitEvent).
  await setSubscription("same-second@example.com", { customerId: "cus_SameSecond01", subscriptionId: "sub_SameSecondPlan01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail("same-second@example.com"))!;
  is("an endpoint listening for them is kept", (await addEndpoint(store, "https://hooks.example.net/in", listen)).ok, true);
  asked.length = 0;
  return store;
}

async function main() {
  part("Three changes of one membership in the same second are three messages");
  const store = await setup(["membership.changed"]);
  const at = 1_790_100_000;
  const a = item("price_a", 1900, "month");
  const b = item("price_b", 2900, "month");
  events = [
    // Stripe lists newest first.
    { id: "evt_Third", type: "customer.subscription.updated", created: at, data: { object: sub("sub_Same", { items: b }), previous_attributes: { items: a } } },
    { id: "evt_Second", type: "customer.subscription.updated", created: at, data: { object: sub("sub_Same", { items: a }), previous_attributes: { items: b } } },
    { id: "evt_First", type: "customer.subscription.updated", created: at, data: { object: sub("sub_Same", { items: b }), previous_attributes: { items: a } } },
  ];
  await watchStripe(Date.now() + 10_000);
  const sent = await recentMessages(store, "membership.changed", 10);
  is("each change is sent: three messages", sent.length, 3);
  is("each has its own event id", new Set(sent.map((m) => m.id)).size, 3);
  const moves = sent.map((m) => `${(m.data as { from: { price: string } }).from.price}->${(m.data as { to: { price: string } }).to.price}`).sort();
  is("two moves to B and one back to A", moves, ["price_a->price_b", "price_a->price_b", "price_b->price_a"]);

  part("A Stripe event noticed again is still sent once");
  await watchStripe(Date.now() + 10_000);
  is("still three", (await recentMessages(store, "membership.changed", 10)).length, 3);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
