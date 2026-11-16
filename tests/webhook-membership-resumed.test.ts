/**
 * The webhook event membership.resumed (378 [TB4] complement WG (a)): read by
 * the five-minute watch of the creator's own Stripe account (lib/webhooks.ts,
 * watchStripe) from Stripe's customer.subscription.updated, when the update
 * takes a membership's pause_collection off: the member's resume link
 * (lib/membership-pause.ts, resumeMembership), the Stripe dashboard, or
 * Stripe itself when the pause reaches its end. What is checked, with a
 * synthetic Stripe:
 *
 *   - a pause ended early by the member, after it started: one message with
 *     the membership, the product, the option, how it ended ("early"),
 *     whether the pause had started, when it was set to end, the member's
 *     address and when it was resumed;
 *   - a pause taken off before it started says it never started;
 *   - a pause Stripe ended on its day says "on_schedule";
 *   - the store's payment plans, another store's membership and an update
 *     that does not touch the pause send nothing; read again, sent once;
 *   - an address that cannot be read waits for the next run; an endpoint
 *     that does not listen for it asks for no address.
 */
import { readFileSync } from "node:fs";
import { WEBHOOK_EVENTS, addEndpoint, recentMessages, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_membership_resumed_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_MemberResume1";
const HANDLE = "member-resume-shop";
let events: unknown[] = [];
const asked: string[] = [];
let customerDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== account) throw new Error(`unexpected synthetic operation ${url}`);
  asked.push(url.pathname);
  if (url.pathname === "/v1/events") return Response.json({ data: events, has_more: false });
  const customer = url.pathname.match(/^\/v1\/customers\/(cus_\w+)$/)?.[1];
  if (customer === "cus_Ada" && customerDown) return Response.json({ error: { type: "api_error", message: "down" } }, { status: 500 });
  if (customer === "cus_Ada") return Response.json({ id: customer, email: "ada@example.com" });
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
}) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const logged = console.error;
console.error = (...args: unknown[]) => (/webhook delivery failed|failed at Stripe/.test(String(args[0])) ? undefined : logged(...args));

const FROM = 1_791_000_000;
const UNTIL = 1_796_000_000;
const meta = { store: HANDLE, product: "p_member", option: "gold" };
/** A membership just resumed, as Stripe shows it after the member's resume: no pause, pause_from cleared. */
const sub = (id: string, extra: Record<string, unknown>) => ({ id, object: "subscription", customer: "cus_Ada", status: "active", cancel_at_period_end: false, cancel_at: null, pause_collection: null, metadata: { ...meta, pause_from: "", paused_at: "1790600000" }, ...extra });
const was = (extra: Record<string, unknown> = {}) => ({ pause_collection: { behavior: "void", resumes_at: UNTIL }, metadata: { ...meta, pause_from: String(FROM), paused_at: "1790600000" }, ...extra });
const evt = (id: string, created: number, object: Record<string, unknown>, previous: Record<string, unknown> = was()) => ({ id, type: "customer.subscription.updated", created, data: { object, previous_attributes: previous } });
type Resumed = { subscription: string; product: { id: string }; option: string | null; how: string; pause_started: boolean; paused_until: string | null; buyer: { email: string | null; customer: string | null }; resumed_at: string };
const iso = (s: number) => new Date(s * 1000).toISOString();

async function setup(listen: string[]) {
  redis.clear();
  await claimHandle("member-resume@example.com", HANDLE, "Member Resume", "");
  await ensureStatsId("member-resume@example.com");
  await setStripeAccount("member-resume@example.com", account);
  await setSubscription("member-resume@example.com", { customerId: "cus_ResumePlan1", subscriptionId: "sub_ResumePlan1", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail("member-resume@example.com"))!;
  is("an endpoint is kept", (await addEndpoint(store, "https://hooks.example.net/in", listen)).ok, true);
  asked.length = 0;
  return store;
}

async function main() {
  part("An event a store can listen for, in the studio's list");
  is("membership.resumed is one of the events", (WEBHOOK_EVENTS as readonly string[]).includes("membership.resumed"), true);
  is("the studio lists it", readFileSync("components/webhook-editor.tsx", "utf8").includes('key: "membership.resumed", label: "Membership resumed"'), true);

  part("Resumed early, before it started, on its day; nothing for the rest");
  const store = await setup(["membership.resumed"]);
  events = [
    evt("evt_Early", FROM + 86_400, sub("sub_A", {})),
    evt("evt_Before", FROM - 86_400, sub("sub_B", {})),
    evt("evt_OnDay", UNTIL + 60, sub("sub_C", { metadata: { ...meta, pause_from: String(FROM) } }), { pause_collection: { behavior: "void", resumes_at: UNTIL } }),
    evt("evt_Plan", FROM + 100, sub("sub_Plan", { metadata: { ...meta, kind: "plan" } })),
    evt("evt_Other", FROM + 200, sub("sub_Other", { metadata: { store: "someone-else", product: "p_x" } })),
    evt("evt_Price", FROM + 300, sub("sub_P", {}), { metadata: { ...meta } }),
  ];
  await watchStripe(Date.now() + 10_000);
  let sent = (await recentMessages(store, "membership.resumed", 10)).map((m) => m.data as Resumed);
  is("three messages, the store's memberships", sent.map((d) => d.subscription).sort(), ["sub_A", "sub_B", "sub_C"]);
  const a = sent.find((d) => d.subscription === "sub_A");
  is("the membership, the product, the option", [a?.product.id, a?.option], ["p_member", "gold"]);
  is("early, after the pause started, set to end then, resumed now", [a?.how, a?.pause_started, a?.paused_until, a?.resumed_at], ["early", true, iso(UNTIL), iso(FROM + 86_400)]);
  is("the member's address", a?.buyer, { email: "ada@example.com", customer: "cus_Ada" });
  is("taken off before it started: it never started", [sent.find((d) => d.subscription === "sub_B")?.how, sent.find((d) => d.subscription === "sub_B")?.pause_started], ["early", false]);
  is("ended by Stripe on its day", [sent.find((d) => d.subscription === "sub_C")?.how, sent.find((d) => d.subscription === "sub_C")?.pause_started], ["on_schedule", true]);
  await watchStripe(Date.now() + 10_000);
  is("read again, still sent once", (await recentMessages(store, "membership.resumed", 10)).length, 3);

  part("An address that cannot be read waits; an endpoint not listening asks for none");
  let other = await setup(["membership.resumed"]);
  customerDown = true;
  events = [evt("evt_Wait", FROM + 500, sub("sub_W", {}))];
  await watchStripe(Date.now() + 10_000);
  is("not sent without the address", (await recentMessages(other, "membership.resumed", 10)).length, 0);
  customerDown = false;
  await watchStripe(Date.now() + 10_000);
  sent = (await recentMessages(other, "membership.resumed", 10)).map((m) => m.data as Resumed);
  is("the next run sends it, with the address", [sent.length, sent[0]?.buyer.email], [1, "ada@example.com"]);
  other = await setup(["membership.paused"]);
  events = [evt("evt_Deaf", FROM + 600, sub("sub_X", {}))];
  await watchStripe(Date.now() + 10_000);
  is("no customer asked, nothing sent", [asked.filter((p) => p.startsWith("/v1/customers/")), (await recentMessages(other, "membership.resumed", 10)).length], [[], 0]);

  done();
}

void main();
