/**
 * The webhook event membership.trial_ending (378 [TB4] complement WG (a)):
 * read by the five-minute watch of the creator's own Stripe account
 * (lib/webhooks.ts, watchStripe) from Stripe's
 * customer.subscription.trial_will_end, which Stripe sends three days before
 * a free trial ends. What is checked, with a synthetic Stripe:
 *
 *   - a membership of this store: one message with the membership, the
 *     product, the option, when the trial ends and the member's address, read
 *     with one of the run's lookups;
 *   - the store's own plan, another store's, one with no trial end: nothing;
 *   - read again, still sent once; the same membership with its trial moved
 *     to another end is told again;
 *   - a member's address that cannot be read now waits for the next run, never
 *     goes out without it; one Stripe no longer has goes out with none;
 *   - the watch asks Stripe for it, and an endpoint that does not listen for it
 *     asks for no address.
 */
import { readFileSync } from "node:fs";
import { WEBHOOK_EVENTS, addEndpoint, recentMessages, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_trial_ending_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_TrialEnding01";
const HANDLE = "trial-ending-shop";
let events: unknown[] = [];
const asked: string[] = [];
const queries: string[] = [];
let customerDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== account) throw new Error(`unexpected synthetic operation ${url}`);
  asked.push(url.pathname);
  if (url.pathname === "/v1/events") {
    queries.push(url.search);
    return Response.json({ data: events, has_more: false });
  }
  const customer = url.pathname.match(/^\/v1\/customers\/(cus_\w+)$/)?.[1];
  if (customer === "cus_Ada" && customerDown) return Response.json({ error: { type: "api_error", message: "down" } }, { status: 500 });
  if (customer === "cus_Ada") return Response.json({ id: customer, email: "ada@example.com" });
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
}) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const logged = console.error;
console.error = (...args: unknown[]) => (/webhook delivery failed|trial ending failed at Stripe/.test(String(args[0])) ? undefined : logged(...args));

const sub = (id: string, extra: Record<string, unknown>) => ({ id, object: "subscription", customer: "cus_Ada", trial_end: 1_791_000_000, metadata: { store: HANDLE, product: "p_member", option: "gold" }, ...extra });
const evt = (id: string, created: number, object: Record<string, unknown>) => ({ id, type: "customer.subscription.trial_will_end", created, data: { object } });

async function setup(listen: string[]) {
  redis.clear();
  await claimHandle("trial-ending@example.com", HANDLE, "Trial Ending", "");
  await ensureStatsId("trial-ending@example.com");
  await setStripeAccount("trial-ending@example.com", account);
  await setSubscription("trial-ending@example.com", { customerId: "cus_TrialPlan01", subscriptionId: "sub_TrialPlan01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail("trial-ending@example.com"))!;
  is("an endpoint is kept", (await addEndpoint(store, "https://hooks.example.net/in", listen)).ok, true);
  asked.length = 0;
  queries.length = 0;
  return store;
}

async function main() {
  part("An event a store can listen for, in the studio's list");
  is("membership.trial_ending is one of the events", (WEBHOOK_EVENTS as readonly string[]).includes("membership.trial_ending"), true);
  is("the studio lists it", readFileSync("components/webhook-editor.tsx", "utf8").includes('key: "membership.trial_ending", label: "Trial ending"'), true);

  part("A membership of this store; nothing for the store's plan, another store's or no trial end");
  let store = await setup(["membership.trial_ending"]);
  events = [
    evt("evt_Trial", 1_790_700_000, sub("sub_A", {})),
    evt("evt_Plan", 1_790_700_100, sub("sub_Plan", { metadata: { store: HANDLE, kind: "plan" } })),
    evt("evt_Other", 1_790_700_200, sub("sub_Other", { metadata: { store: "someone-else", product: "p_x" } })),
    evt("evt_NoEnd", 1_790_700_300, sub("sub_NoEnd", { trial_end: null })),
  ];
  await watchStripe(Date.now() + 10_000);
  let sent = await recentMessages(store, "membership.trial_ending", 10);
  is("one message, for the store's membership", sent.map((m) => (m.data as { subscription: string }).subscription), ["sub_A"]);
  const d = (sent[0]?.data ?? {}) as Record<string, unknown>;
  is("the membership, the product, the option, when the trial ends and the member's address", [(d.product as { id: string }).id, d.option, d.trial_ends_at, d.buyer], ["p_member", "gold", new Date(1_791_000_000_000).toISOString(), { email: "ada@example.com", customer: "cus_Ada" }]);
  is("the watch asks Stripe for it", queries.some((q) => decodeURIComponent(q).includes("customer.subscription.trial_will_end")), true);
  await watchStripe(Date.now() + 10_000);
  is("read again, still sent once", (await recentMessages(store, "membership.trial_ending", 10)).length, 1);
  events = [evt("evt_Moved", 1_790_800_000, sub("sub_A", { trial_end: 1_791_500_000 }))];
  await watchStripe(Date.now() + 10_000);
  sent = await recentMessages(store, "membership.trial_ending", 10);
  is("its trial moved to another end: told again, with the new end", [sent.length, (sent[0]?.data as { trial_ends_at: string }).trial_ends_at], [2, new Date(1_791_500_000_000).toISOString()]);

  part("A member's address that cannot be read waits; one Stripe no longer has goes with none");
  store = await setup(["membership.trial_ending"]);
  customerDown = true;
  events = [evt("evt_Wait", 1_790_900_000, sub("sub_W", {}))];
  await watchStripe(Date.now() + 10_000);
  is("not sent without the address", (await recentMessages(store, "membership.trial_ending", 10)).length, 0);
  customerDown = false;
  await watchStripe(Date.now() + 10_000);
  sent = await recentMessages(store, "membership.trial_ending", 10);
  is("the next run sends it, with the address", [sent.length, (sent[0]?.data as { buyer: { email: string } })?.buyer.email], [1, "ada@example.com"]);
  events = [evt("evt_Gone", 1_790_950_000, sub("sub_G", { customer: "cus_Gone" }))];
  await watchStripe(Date.now() + 10_000);
  const gone = (await recentMessages(store, "membership.trial_ending", 10)).find((m) => (m.data as { subscription: string }).subscription === "sub_G");
  is("a customer Stripe no longer has: sent with no address", (gone?.data as { buyer: unknown })?.buyer, { email: null, customer: "cus_Gone" });

  part("An endpoint that does not listen for it asks for no address");
  store = await setup(["sale.completed"]);
  events = [evt("evt_Deaf", 1_791_000_000, sub("sub_D", {}))];
  await watchStripe(Date.now() + 10_000);
  is("no customer asked", asked.filter((p) => p.startsWith("/v1/customers/")), []);
  is("nothing sent", (await recentMessages(store, "membership.trial_ending", 10)).length, 0);

  done();
}

void main();
