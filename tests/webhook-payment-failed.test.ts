/**
 * The webhook event payment.failed (378 [TB4] complement WG (a)): read by the
 * five-minute watch of the creator's own Stripe account (lib/webhooks.ts,
 * watchStripe) from Stripe's invoice.payment_failed, which Stripe sends each
 * time a renewal of a membership, or a payment of a payment plan, is tried
 * and fails. What is checked, with a synthetic Stripe:
 *
 *   - a membership's renewal of this store: one message with the invoice, the
 *     membership, the product, the option, the amount, the try it was and when
 *     Stripe tries again, and the member's address as the invoice carries it
 *     (no lookup asked);
 *   - a payment plan's payment says it is one; an invoice of another store,
 *     or one no subscription made, sends nothing;
 *   - the subscription's metadata is read where either of Stripe's API
 *     versions keeps it;
 *   - read again, still sent once; the next failed try of the same invoice is
 *     told again, and the last one says Stripe tries no more;
 *   - an amount that does not read is never sent as $0: it waits;
 *   - the watch asks Stripe for it; an endpoint that does not listen for it
 *     is sent nothing.
 */
import { readFileSync } from "node:fs";
import { WEBHOOK_EVENTS, addEndpoint, recentMessages, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_payment_failed_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_PayFailed0001";
const HANDLE = "payment-failed-shop";
let events: unknown[] = [];
const asked: string[] = [];
const queries: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== account) throw new Error(`unexpected synthetic operation ${url}`);
  asked.push(url.pathname);
  if (url.pathname === "/v1/events") {
    queries.push(url.search);
    return Response.json({ data: events, has_more: false });
  }
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
}) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const logged = console.error;
console.error = (...args: unknown[]) => (/webhook delivery failed|OUR CODE FAILED|unknown shape/.test(String(args[0])) ? undefined : logged(...args));

const meta = { store: HANDLE, product: "p_member", option: "gold" };
/** An invoice in the pinned API version: its subscription and that subscription's metadata under parent. */
const invoice = (id: string, extra: Record<string, unknown>, subMeta: Record<string, string> = meta) => ({
  id,
  object: "invoice",
  customer: "cus_Ada",
  customer_email: "ada@example.com",
  amount_due: 2900,
  currency: "usd",
  attempt_count: 1,
  next_payment_attempt: 1_791_300_000,
  billing_reason: "subscription_cycle",
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_A", metadata: subMeta } },
  ...extra,
});
const evt = (id: string, created: number, object: Record<string, unknown>) => ({ id, type: "invoice.payment_failed", created, data: { object } });
type Failed = { invoice: string; subscription: string; kind: string; product: { id: string }; option: string | null; amount_cents: number; currency: string; attempt: number; next_attempt_at: string | null; buyer: { email: string | null; customer: string | null }; failed_at: string };

async function setup(listen: string[]) {
  redis.clear();
  await claimHandle("payment-failed@example.com", HANDLE, "Payment Failed", "");
  await ensureStatsId("payment-failed@example.com");
  await setStripeAccount("payment-failed@example.com", account);
  await setSubscription("payment-failed@example.com", { customerId: "cus_PayFailPlan1", subscriptionId: "sub_PayFailPlan1", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail("payment-failed@example.com"))!;
  is("an endpoint is kept", (await addEndpoint(store, "https://hooks.example.net/in", listen)).ok, true);
  asked.length = 0;
  queries.length = 0;
  return store;
}

async function main() {
  part("An event a store can listen for, in the studio's list");
  is("payment.failed is one of the events", (WEBHOOK_EVENTS as readonly string[]).includes("payment.failed"), true);
  is("the studio lists it", readFileSync("components/webhook-editor.tsx", "utf8").includes('key: "payment.failed", label: "Payment failed"'), true);

  part("A membership's renewal of this store; a payment plan's; nothing for another store's or no subscription's");
  let store = await setup(["payment.failed"]);
  events = [
    evt("evt_Fail", 1_790_700_000, invoice("in_A", {})),
    evt("evt_Plan", 1_790_700_100, invoice("in_Plan", { amount_due: 5000 }, { store: HANDLE, product: "p_course", kind: "plan" })),
    evt("evt_Other", 1_790_700_200, invoice("in_Other", {}, { store: "someone-else", product: "p_x" })),
    evt("evt_NoSub", 1_790_700_300, invoice("in_NoSub", { parent: null })),
  ];
  await watchStripe(Date.now() + 10_000);
  let sent = (await recentMessages(store, "payment.failed", 10)).map((m) => m.data as Failed);
  is("two messages: the membership's and the payment plan's", sent.map((d) => d.invoice).sort(), ["in_A", "in_Plan"]);
  const a = sent.find((d) => d.invoice === "in_A");
  is("the invoice, the membership, the product, the option and its kind", [a?.subscription, a?.product.id, a?.option, a?.kind], ["sub_A", "p_member", "gold", "membership"]);
  is("the amount, the try, when Stripe tries again, when it failed", [a?.amount_cents, a?.currency, a?.attempt, a?.next_attempt_at, a?.failed_at], [2900, "usd", 1, new Date(1_791_300_000_000).toISOString(), new Date(1_790_700_000_000).toISOString()]);
  is("the member's address as the invoice carries it", a?.buyer, { email: "ada@example.com", customer: "cus_Ada" });
  is("a payment plan's payment says it is one", sent.find((d) => d.invoice === "in_Plan")?.kind, "payment_plan");
  is("no lookup asked of Stripe", asked.filter((p) => p !== "/v1/events"), []);
  is("the watch asks Stripe for it", queries.some((q) => decodeURIComponent(q).includes("invoice.payment_failed")), true);

  part("Read again, sent once; the next failed try is told again");
  await watchStripe(Date.now() + 10_000);
  is("read again, still sent once", (await recentMessages(store, "payment.failed", 10)).length, 2);
  events = [evt("evt_Fail2", 1_790_900_000, invoice("in_A", { attempt_count: 2, next_payment_attempt: null }))];
  await watchStripe(Date.now() + 10_000);
  sent = (await recentMessages(store, "payment.failed", 10)).map((m) => m.data as Failed);
  is("the second failed try: told again, and Stripe tries no more", [sent.length, sent[0]?.attempt, sent[0]?.next_attempt_at], [3, 2, null]);

  part("The subscription's metadata where an older API version keeps it");
  store = await setup(["payment.failed"]);
  events = [evt("evt_Old", 1_791_000_000, invoice("in_Old", { parent: undefined, subscription: "sub_Old", subscription_details: { metadata: meta } }))];
  await watchStripe(Date.now() + 10_000);
  sent = (await recentMessages(store, "payment.failed", 10)).map((m) => m.data as Failed);
  is("sent, with its membership", [sent.length, sent[0]?.subscription], [1, "sub_Old"]);

  part("An amount that does not read waits, never sent as $0");
  store = await setup(["payment.failed"]);
  events = [evt("evt_Bad", 1_791_100_000, invoice("in_Bad", { amount_due: "2900" }))];
  await watchStripe(Date.now() + 10_000);
  is("nothing sent", (await recentMessages(store, "payment.failed", 10)).length, 0);

  part("An endpoint that does not listen for it is sent nothing");
  store = await setup(["sale.completed"]);
  events = [evt("evt_Deaf", 1_791_200_000, invoice("in_Deaf", {}))];
  await watchStripe(Date.now() + 10_000);
  is("nothing sent", (await recentMessages(store, "payment.failed", 10)).length, 0);

  done();
}

void main();
