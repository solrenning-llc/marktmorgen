/**
 * The webhook event membership.paused (378 [TB4] complement WG (a)): read by
 * the five-minute watch of the creator's own Stripe account (lib/webhooks.ts,
 * watchStripe) from Stripe's customer.subscription.updated, when the update
 * sets a membership's pause_collection: the member's pause link
 * (lib/membership-pause.ts, pauseMembership) or a pause made in the Stripe
 * dashboard. What is checked, with a synthetic Stripe:
 *
 *   - a pause set by the member's link: one message with the membership, the
 *     product, the option, what Stripe does with its payments, when the pause
 *     starts (the end of what was paid for), when it ends and the member's
 *     address, read with one of the run's lookups;
 *   - a pause made in the dashboard with no end: starts when it was made, and
 *     ends when the creator says;
 *   - the store's payment plans, another store's membership and an update that
 *     does not touch the pause send nothing;
 *   - read again, still sent once; the pause moved to another end is told
 *     again;
 *   - an update that both pauses and sets an end sends both, reading the
 *     address once;
 *   - a member's address that cannot be read now waits for the next run; an
 *     endpoint that does not listen for it asks for no address.
 */
import { readFileSync } from "node:fs";
import { WEBHOOK_EVENTS, addEndpoint, recentMessages, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_membership_paused_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_MemberPause01";
const HANDLE = "member-pause-shop";
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
const sub = (id: string, extra: Record<string, unknown>) => ({ id, object: "subscription", customer: "cus_Ada", status: "active", cancel_at_period_end: false, cancel_at: null, pause_collection: { behavior: "void", resumes_at: UNTIL }, metadata: { ...meta, pause_from: String(FROM), paused_at: "1790600000" }, ...extra });
const evt = (id: string, created: number, object: Record<string, unknown>, previous: Record<string, unknown> = { pause_collection: null }) => ({ id, type: "customer.subscription.updated", created, data: { object, previous_attributes: previous } });
type Paused = { subscription: string; product: { id: string }; option: string | null; behavior: string; pauses_from: string; resumes_at: string | null; buyer: { email: string | null; customer: string | null }; paused_at: string };
const iso = (s: number) => new Date(s * 1000).toISOString();

async function setup(listen: string[]) {
  redis.clear();
  await claimHandle("member-pause@example.com", HANDLE, "Member Pause", "");
  await ensureStatsId("member-pause@example.com");
  await setStripeAccount("member-pause@example.com", account);
  await setSubscription("member-pause@example.com", { customerId: "cus_PausePlan01", subscriptionId: "sub_PausePlan01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail("member-pause@example.com"))!;
  is("an endpoint is kept", (await addEndpoint(store, "https://hooks.example.net/in", listen)).ok, true);
  asked.length = 0;
  return store;
}

async function main() {
  part("An event a store can listen for, in the studio's list");
  is("membership.paused is one of the events", (WEBHOOK_EVENTS as readonly string[]).includes("membership.paused"), true);
  is("the studio lists it", readFileSync("components/webhook-editor.tsx", "utf8").includes('key: "membership.paused", label: "Membership paused"'), true);

  part("A pause by the member's link; one in the dashboard with no end; nothing for the rest");
  let store = await setup(["membership.paused"]);
  events = [
    evt("evt_Pause", 1_790_600_000, sub("sub_A", {})),
    evt("evt_Dash", 1_790_600_100, sub("sub_D", { pause_collection: { behavior: "keep_as_draft", resumes_at: null }, metadata: meta })),
    evt("evt_Plan", 1_790_600_200, sub("sub_Plan", { metadata: { ...meta, kind: "plan" } })),
    evt("evt_Other", 1_790_600_300, sub("sub_Other", { metadata: { store: "someone-else", product: "p_x" } })),
    evt("evt_Price", 1_790_600_400, sub("sub_P", {}), { metadata: { ...meta } }),
  ];
  await watchStripe(Date.now() + 10_000);
  let sent = (await recentMessages(store, "membership.paused", 10)).map((m) => m.data as Paused);
  is("two messages: the link's and the dashboard's", sent.map((d) => d.subscription).sort(), ["sub_A", "sub_D"]);
  const a = sent.find((d) => d.subscription === "sub_A");
  is("the membership, the product, the option, what Stripe does with its payments", [a?.product.id, a?.option, a?.behavior], ["p_member", "gold", "void"]);
  is("when the pause starts and ends, when it was asked for", [a?.pauses_from, a?.resumes_at, a?.paused_at], [iso(FROM), iso(UNTIL), iso(1_790_600_000)]);
  is("the member's address, from one lookup each", [a?.buyer, asked.filter((p) => p.startsWith("/v1/customers/")).length], [{ email: "ada@example.com", customer: "cus_Ada" }, 2]);
  const d = sent.find((x) => x.subscription === "sub_D");
  is("the dashboard's: starts when it was made, ends when the creator says", [d?.behavior, d?.pauses_from, d?.resumes_at], ["keep_as_draft", iso(1_790_600_100), null]);

  part("Read again, sent once; moved to another end, told again");
  await watchStripe(Date.now() + 10_000);
  is("read again, still sent once", (await recentMessages(store, "membership.paused", 10)).length, 2);
  events = [evt("evt_Longer", 1_790_700_000, sub("sub_A", { pause_collection: { behavior: "void", resumes_at: UNTIL + 2_600_000 } }), { pause_collection: { behavior: "void", resumes_at: UNTIL } })];
  await watchStripe(Date.now() + 10_000);
  sent = (await recentMessages(store, "membership.paused", 10)).map((m) => m.data as Paused);
  is("its pause moved to another end: told again, with the new end", [sent.length, sent[0]?.resumes_at], [3, iso(UNTIL + 2_600_000)]);

  part("Paused and set to end in the same update: both, the address read once");
  store = await setup(["membership.paused", "membership.canceled"]);
  events = [evt("evt_Both", 1_790_800_000, sub("sub_B", { cancel_at_period_end: true, canceled_at: 1_790_800_000 }), { pause_collection: null, cancel_at_period_end: false })];
  await watchStripe(Date.now() + 10_000);
  is("both sent", [(await recentMessages(store, "membership.paused", 10)).length, (await recentMessages(store, "membership.canceled", 10)).length], [1, 1]);
  is("one lookup", asked.filter((p) => p.startsWith("/v1/customers/")).length, 1);

  part("An address that cannot be read waits; an endpoint not listening asks for none");
  store = await setup(["membership.paused"]);
  customerDown = true;
  events = [evt("evt_Wait", 1_790_900_000, sub("sub_W", {}))];
  await watchStripe(Date.now() + 10_000);
  is("not sent without the address", (await recentMessages(store, "membership.paused", 10)).length, 0);
  customerDown = false;
  await watchStripe(Date.now() + 10_000);
  sent = (await recentMessages(store, "membership.paused", 10)).map((m) => m.data as Paused);
  is("the next run sends it, with the address", [sent.length, sent[0]?.buyer.email], [1, "ada@example.com"]);
  store = await setup(["sale.completed"]);
  events = [evt("evt_Deaf", 1_791_000_000, sub("sub_X", {}))];
  await watchStripe(Date.now() + 10_000);
  is("no customer asked, nothing sent", [asked.filter((p) => p.startsWith("/v1/customers/")), (await recentMessages(store, "membership.paused", 10)).length], [[], 0]);

  done();
}

void main();
