/**
 * Third pre-review of claude5/closed-store-deadline, proof (b), copied from the review: an HTML 4xx page in front of
 * Stripe (not JSON) is a passing failure in the webhook watch, as it was before StripeUnreadableReply.
 *
 * Its harness is tests/webhook-subscription-disputes.test.ts's. dispute.opened and refund.issued for a membership's or a payment plan's
 * charge (audit C3-65, item 1). The recurring checkout writes the store only
 * on the subscription (lib/store-checkout.ts, subscription_data), so the
 * invoice's payment carries none: the store is read off the invoice the
 * payment paid. A lookup that fails, or runs past the run's budget, leaves
 * the event for the next run instead of losing it. Synthetic Stripe answers
 * only; the endpoint's name resolves to a private address, so nothing leaves
 * this machine.
 */
import { DISPUTE_LOOKUPS_PER_STORE, GIVEN_UP_LINES_PER_DAY, MAX_ENDPOINTS, removeEndpoint, STRIPE_LOOKUPS_PER_STORE, STRIPE_REFUSED_RUNS, STRIPE_WAIT_RUNS, STRIPE_WAIT_MAX_SECONDS, STRIPE_WAIT_TIME_VISITS, addEndpoint, eventIdFor, recentMessages, resendDelivery, setSendHooksForTests, watchStripe, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_subscription_disputes_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const account = "acct_SubDisputes01";
const HANDLE = "sub-disputes-shop";
const OWNER = "sub-disputes@example.com";

/** The account's events, oldest first; the list honors ending_before as Stripe does. */
let timeline: Record<string, unknown>[] = [];
const intents: Record<string, Record<string, string>> = {};
/** Payment intent to the invoice it paid, as GET /v1/invoice_payments answers. */
const paidBy: Record<string, string> = {};
const invoices: Record<string, Record<string, unknown>> = {};
/** How many more times each path answers 500, fails without an answer, or is refused with another Stripe error. */
type Failure = "500" | "network" | "403" | "400" | "429" | "html" | "html403";
const failing: Record<string, { left: number; how: Failure }> = {};
/** A canceled member's customer record, as GET /v1/customers answers. */
const customers: Record<string, string> = {};
/** Payments whose invoice payments Stripe answers in a shape the code does not know. */
const oddShape = new Set<string>();
/** Customers deleted on the account: Stripe answers 200 with { deleted: true } and no address. */
const deletedCustomers = new Set<string>();
const asked: { path: string; version: string | null }[] = [];
/** Run once when the next visit reads its events: something that happens while a visit is under way. */
let duringEvents: (() => Promise<unknown>) | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET" || headers.get("Stripe-Account") !== account) throw new Error(`unexpected synthetic operation ${url}`);
  const key = `${url.pathname}${url.pathname === "/v1/invoice_payments" ? `?${url.searchParams.get("payment[payment_intent]")}` : ""}`;
  if (url.pathname !== "/v1/events") asked.push({ path: key, version: headers.get("Stripe-Version") });
  const fail = failing[key];
  if (fail && fail.left > 0) {
    fail.left -= 1;
    if (fail.how === "network") throw new TypeError("fetch failed");
    if (fail.how === "403") return Response.json({ error: { type: "invalid_request_error", code: "account_invalid", message: "The account cannot be read." } }, { status: 403 });
    // An error page in front of Stripe: not JSON at all.
    if (fail.how === "html403") return new Response("<html><body>403 Forbidden (edge)</body></html>", { status: 403, headers: { "Content-Type": "text/html" } });
    if (fail.how === "html") return new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "Content-Type": "text/html" } });
    if (fail.how === "429") return Response.json({ error: { type: "invalid_request_error", code: "rate_limit", message: "Too many requests." } }, { status: 429 });
    if (fail.how === "400") return Response.json({ error: { type: "invalid_request_error", code: "parameter_unknown", message: "Received unknown parameter." } }, { status: 400 });
    return Response.json({ error: { type: "api_error", message: "Something went wrong on Stripe's end." } }, { status: 500 });
  }
  if (url.pathname === "/v1/events") {
    if (duringEvents) {
      const run = duringEvents;
      duringEvents = null;
      await run();
    }
    const before = url.searchParams.get("ending_before");
    const at = before ? timeline.findIndex((e) => e.id === before) : -1;
    const rows = (at >= 0 ? timeline.slice(at + 1) : timeline).slice().reverse();
    return Response.json({ data: rows, has_more: false });
  }
  const intent = url.pathname.match(/^\/v1\/payment_intents\/(pi_\w+)$/)?.[1];
  if (intent && intents[intent]) return Response.json({ id: intent, object: "payment_intent", metadata: intents[intent] });
  if (url.pathname === "/v1/invoice_payments") {
    const pi = url.searchParams.get("payment[payment_intent]") ?? "";
    const bad = url.searchParams.get("payment[type]") !== "payment_intent" || url.searchParams.get("limit") !== "1";
    if (bad) return Response.json({ error: { message: "Invalid filter" } }, { status: 400 });
    const invoice = paidBy[pi];
    if (oddShape.has(pi)) return Response.json({ object: "list", data: "not a list", has_more: false });
    return Response.json({ object: "list", data: invoice ? [{ id: `inpay_${pi}`, object: "invoice_payment", invoice, status: "paid", payment: { type: "payment_intent", payment_intent: pi } }] : [], has_more: false });
  }
  const invoice = url.pathname.match(/^\/v1\/invoices\/(in_\w+)$/)?.[1];
  if (invoice && invoices[invoice]) return Response.json({ id: invoice, object: "invoice", ...invoices[invoice] });
  const customer = url.pathname.match(/^\/v1\/customers\/(cus_\w+)$/)?.[1];
  if (customer && deletedCustomers.has(customer)) return Response.json({ id: customer, object: "customer", deleted: true });
  if (customer && customers[customer]) return Response.json({ id: customer, object: "customer", email: customers[customer] });
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
}) as typeof fetch;
// The endpoint's name resolves to a private address: every try is refused before any socket opens.
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const logged = console.error;
const said: string[] = [];
console.error = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  // The memory store cannot run the delivery claim's script; the try that fails here is not what is checked.
  if (line.startsWith("a webhook delivery failed")) return;
  said.push(line);
};

const subscriptionInvoice = (meta: Record<string, string>) => ({ parent: { type: "subscription_details", subscription_details: { subscription: "sub_Member01", metadata: meta } } });
const dispute = (id: string, intent: string) => ({ id, object: "dispute", charge: `ch_${id}`, payment_intent: intent, amount: 2900, currency: "usd", reason: "product_not_received", status: "needs_response", evidence_details: { due_by: 1_791_000_000 }, metadata: {} });
const refund = (id: string, intent: string, metadata: Record<string, string> = {}) => ({ id, object: "charge", payment_intent: intent, amount: 2900, amount_refunded: 2900, refunded: true, currency: "usd", metadata, billing_details: { email: null, name: null } });
const evt = (id: string, type: string, created: number, object: Record<string, unknown>) => ({ id, type, created, data: { object } });
const sentIds = async (store: Awaited<ReturnType<typeof setup>>, type: "dispute.opened" | "refund.issued", key: "dispute" | "charge") =>
  (await recentMessages(store, type, 10)).map((m) => (m.data as Record<string, string>)[key]).sort();
const lookups = () => asked.filter((a) => a.path !== "/v1/events");
let statsId = "";
const anchor = async () => (await redis.pipeline([["GET", `nl:hooks:anchor:${statsId}`]]))[0];
const waitRecord = async () => (await redis.pipeline([["GET", `nl:hooks:wait:${statsId}`]]))[0];
/** The wait record without the time it began: "<evt>|<visits>". */
const waitOf = async () => {
  const raw = await waitRecord();
  return typeof raw === "string" ? raw.split("|").slice(0, 2).join("|") : raw;
};
const nowSeconds = () => Math.floor(Date.now() / 1000);
const anchorTtl = async () => Number((await redis.pipeline([["TTL", `nl:hooks:anchor:${statsId}`]]))[0]);
const cancel = (n: number) => evt(`evt_Cancel${n}`, "customer.subscription.updated", 1_790_070_000 + n, {
  id: `sub_Cancel${n}`, object: "subscription", customer: `cus_Cancel${n}`, cancel_at_period_end: true, current_period_end: 1_792_000_000,
  metadata: { store: HANDLE, product: "p_member" },
});
const cancelPrevious = { cancel_at_period_end: false };

async function setup(listen: string[]) {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Sub Disputes", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, account);
  // A paid plan, so its messages are kept: a store whose month has no webhook deliveries keeps none (lib/webhooks.ts, emitEvent).
  await setSubscription(OWNER, { customerId: "cus_SubDisputesSetup", subscriptionId: "sub_SubDisputesSetup", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  statsId = store.statsId as string;
  is("an endpoint listening for them is kept", (await addEndpoint(store, "https://hooks.example.net/in", listen)).ok, true);
  for (const k of Object.keys(failing)) delete failing[k];
  asked.length = 0;
  said.length = 0;
  return store;
}

async function main() {
  intents.pi_Member = {};
  paidBy.pi_Member = "in_Member01";
  invoices.in_Member01 = subscriptionInvoice({ store: HANDLE, product: "p_member", option: "gold" });
  part("PROOF (b): an HTML 4xx page in front of Stripe (not JSON) waits as a passing failure, as before the delta");
  const s4 = await setup(["dispute.opened"]);
  const gl = async () => (await webhooksView(s4)).log.filter((d) => d.givenUp);
  timeline = [evt("evt_Html4", "charge.dispute.created", 1_790_142_000, dispute("dp_html4", "pi_Member"))];
  failing["/v1/invoices/in_Member01"] = { left: 1_000_000, how: "html403" };
  for (let visit = 0; visit < STRIPE_REFUSED_RUNS + 1; visit += 1) await watchStripe(Date.now() + 10_000);
  is("still waiting past a refusal's visits, with no given-up line", [await waitOf(), (await gl()).length], [`evt_Html4|${STRIPE_REFUSED_RUNS + 1}`, 0]);
  console.error = logged;
  done();
}

void main();
