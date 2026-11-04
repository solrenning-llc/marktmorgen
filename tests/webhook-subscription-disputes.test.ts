/**
 * dispute.opened and refund.issued for a membership's or a payment plan's
 * charge (audit C3-65, item 1). The recurring checkout writes the store only
 * on the subscription (lib/store-checkout.ts, subscription_data), so the
 * invoice's payment carries none: the store is read off the invoice the
 * payment paid. A lookup that fails, or runs past the run's budget, leaves
 * the event for the next run instead of losing it. Synthetic Stripe answers
 * only; the endpoint's name resolves to a private address, so nothing leaves
 * this machine.
 */
import { DISPUTE_LOOKUPS_PER_STORE, STRIPE_LOOKUPS_PER_STORE, STRIPE_WAIT_RUNS, addEndpoint, recentMessages, resendDelivery, setSendHooksForTests, watchStripe, webhooksView } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
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
type Failure = "500" | "network" | "403" | "400";
const failing: Record<string, { left: number; how: Failure }> = {};
/** A canceled member's customer record, as GET /v1/customers answers. */
const customers: Record<string, string> = {};
/** Customers deleted on the account: Stripe answers 200 with { deleted: true } and no address. */
const deletedCustomers = new Set<string>();
const asked: { path: string; version: string | null }[] = [];

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
    if (fail.how === "400") return Response.json({ error: { type: "invalid_request_error", code: "parameter_unknown", message: "Received unknown parameter." } }, { status: 400 });
    return Response.json({ error: { type: "api_error", message: "Something went wrong on Stripe's end." } }, { status: 500 });
  }
  if (url.pathname === "/v1/events") {
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
  const store = (await storeForEmail(OWNER))!;
  statsId = store.statsId as string;
  is("an endpoint listening for them is kept", (await addEndpoint(store, "https://hooks.example.net/in", listen)).ok, true);
  for (const k of Object.keys(failing)) delete failing[k];
  asked.length = 0;
  said.length = 0;
  return store;
}

async function main() {
  // A membership's charge: its payment carries no store; its invoice's subscription does.
  intents.pi_Member = {};
  paidBy.pi_Member = "in_Member01";
  invoices.in_Member01 = subscriptionInvoice({ store: HANDLE, product: "p_member", option: "gold" });
  // A payment plan's instalment, on an account answering in the older shape (subscription_details on the invoice itself).
  intents.pi_Plan = {};
  paidBy.pi_Plan = "in_Plan01";
  invoices.in_Plan01 = { subscription_details: { metadata: { store: HANDLE, product: "p_plan", kind: "plan" } } };
  // A one-off checkout's payment, which carries the store itself.
  intents.pi_Once = { store: HANDLE, product: "p_course" };
  // Another store's membership on the same account, and a payment no checkout and no subscription made.
  intents.pi_Theirs = {};
  paidBy.pi_Theirs = "in_Theirs01";
  invoices.in_Theirs01 = subscriptionInvoice({ store: "someone-else", product: "p_x" });
  intents.pi_Loose = {};

  part("dispute.opened for a membership's charge, a plan's and a one-off");
  let store = await setup(["dispute.opened"]);
  timeline = [
    evt("evt_DpMember", "charge.dispute.created", 1_790_010_000, dispute("dp_member", "pi_Member")),
    evt("evt_DpOnce", "charge.dispute.created", 1_790_010_100, dispute("dp_once", "pi_Once")),
    evt("evt_DpPlan", "charge.dispute.created", 1_790_010_200, dispute("dp_plan", "pi_Plan")),
    evt("evt_DpTheirs", "charge.dispute.created", 1_790_010_300, dispute("dp_theirs", "pi_Theirs")),
    evt("evt_DpLoose", "charge.dispute.created", 1_790_010_400, dispute("dp_loose", "pi_Loose")),
  ];
  await watchStripe(Date.now() + 10_000);
  is("the membership's and the plan's disputes are sent beside the one-off's; no one else's", await sentIds(store, "dispute.opened", "dispute"), ["dp_member", "dp_once", "dp_plan"]);
  const member = (await recentMessages(store, "dispute.opened", 10)).find((m) => (m.data as { dispute: string }).dispute === "dp_member")!.data as Record<string, unknown>;
  is("with the product and option the subscription carries", [(member.product as { id: string }).id, member.option, member.payment_intent, member.evidence_due_by], ["p_member", "gold", "pi_Member", new Date(1_791_000_000_000).toISOString()]);
  is("a one-off payment is asked about once, as before; a membership's through its invoice", lookups().map((a) => a.path), [
    "/v1/payment_intents/pi_Member", "/v1/invoice_payments?pi_Member", "/v1/invoices/in_Member01",
    "/v1/payment_intents/pi_Once",
    "/v1/payment_intents/pi_Plan", "/v1/invoice_payments?pi_Plan", "/v1/invoices/in_Plan01",
    "/v1/payment_intents/pi_Theirs", "/v1/invoice_payments?pi_Theirs", "/v1/invoices/in_Theirs01",
  ]);
  // pi_Loose: only ten dispute lookups a run, so the loose payment's is the next run's.
  is("every lookup is read in one fixed API version", [...new Set(lookups().map((a) => a.version))], ["2026-08-26.dahlia"]);
  is("the run stopped before the dispute past its budget and kept the anchor there", await anchor(), "evt_DpTheirs");
  is("said in the log, never silently", said.some((line) => line.includes("more disputes in one run") && line.includes("wait for the next run")), true);
  asked.length = 0;
  await watchStripe(Date.now() + 10_000);
  is("the next run reads on from there: a payment with no invoice costs two calls and sends nothing", lookups().map((a) => a.path), ["/v1/payment_intents/pi_Loose", "/v1/invoice_payments?pi_Loose"]);
  is("and the anchor reaches the newest", await anchor(), "evt_DpLoose");
  is("nothing sent twice", await sentIds(store, "dispute.opened", "dispute"), ["dp_member", "dp_once", "dp_plan"]);

  part("refund.issued for a membership's charge; a one-off unchanged");
  store = await setup(["refund.issued"]);
  timeline = [
    evt("evt_RfMember", "charge.refunded", 1_790_020_000, refund("ch_member", "pi_Member")),
    evt("evt_RfOnceMeta", "charge.refunded", 1_790_020_100, refund("ch_once_meta", "pi_Unasked", { store: HANDLE, product: "p_course" })),
    evt("evt_RfOnce", "charge.refunded", 1_790_020_200, refund("ch_once", "pi_Once")),
    evt("evt_RfTheirs", "charge.refunded", 1_790_020_300, refund("ch_theirs", "pi_Theirs")),
  ];
  await watchStripe(Date.now() + 10_000);
  is("the membership's refund is sent beside the one-off ones; not another store's", await sentIds(store, "refund.issued", "charge"), ["ch_member", "ch_once", "ch_once_meta"]);
  const rf = (await recentMessages(store, "refund.issued", 10)).find((m) => (m.data as { charge: string }).charge === "ch_member")!.data as Record<string, unknown>;
  is("with the subscription's product", [(rf.product as { id: string }).id, rf.amount_refunded_cents], ["p_member", 2900]);
  is("a charge with the store on it asks nothing; a one-off's payment one call", lookups().map((a) => a.path), [
    "/v1/payment_intents/pi_Member", "/v1/invoice_payments?pi_Member", "/v1/invoices/in_Member01",
    "/v1/payment_intents/pi_Once",
    "/v1/payment_intents/pi_Theirs", "/v1/invoice_payments?pi_Theirs", "/v1/invoices/in_Theirs01",
  ]);
  is("the anchor reaches the newest", await anchor(), "evt_RfTheirs");

  part("A lookup that fails keeps the anchor and is tried again");
  for (const how of ["500", "network"] as const) {
    store = await setup(["dispute.opened", "refund.issued"]);
    timeline = [
      evt("evt_FBefore", "charge.dispute.created", 1_790_030_000, dispute("dp_before", "pi_Once")),
      evt("evt_FMember", "charge.dispute.created", 1_790_030_100, dispute("dp_failed", "pi_Member")),
      evt("evt_FAfter", "charge.refunded", 1_790_030_200, refund("ch_after", "pi_Once")),
    ];
    failing["/v1/invoices/in_Member01"] = { left: 1, how };
    await watchStripe(Date.now() + 10_000);
    is(`${how}: the dispute before is sent; the one whose invoice failed is not yet`, await sentIds(store, "dispute.opened", "dispute"), ["dp_before"]);
    is(`${how}: the anchor stays on the last event done with, not past the failed one`, await anchor(), "evt_FBefore");
    is(`${how}: the event after it waits too`, await sentIds(store, "refund.issued", "charge"), []);
    is(`${how}: said in the log`, said.some((line) => line.includes("read again next run")), true);
    await watchStripe(Date.now() + 10_000);
    is(`${how}: the next run sends it, and what came after`, [await sentIds(store, "dispute.opened", "dispute"), await sentIds(store, "refund.issued", "charge")], [["dp_before", "dp_failed"], ["ch_after"]]);
    is(`${how}: and moves the anchor on`, await anchor(), "evt_FAfter");
  }

  part("A first run whose lookup fails keeps no anchor past it");
  store = await setup(["dispute.opened"]);
  timeline = [evt("evt_First", "charge.dispute.created", 1_790_040_000, dispute("dp_first", "pi_Member"))];
  failing["/v1/payment_intents/pi_Member"] = { left: 1, how: "500" };
  await watchStripe(Date.now() + 10_000);
  is("nothing sent and no anchor set", [await sentIds(store, "dispute.opened", "dispute"), await anchor()], [[], null]);
  await watchStripe(Date.now() + 10_000);
  is("read again from the start and sent", [await sentIds(store, "dispute.opened", "dispute"), await anchor()], [["dp_first"], "evt_First"]);

  part("A payment Stripe does not know is not waited on forever");
  store = await setup(["dispute.opened"]);
  timeline = [
    evt("evt_Gone", "charge.dispute.created", 1_790_050_000, dispute("dp_gone", "pi_Gone")),
    evt("evt_Next", "charge.dispute.created", 1_790_050_100, dispute("dp_next", "pi_Member")),
  ];
  await watchStripe(Date.now() + 10_000);
  is("a 404 is passed over, said in the log; the next one is sent", [await sentIds(store, "dispute.opened", "dispute"), await anchor(), said.some((line) => line.includes("does not know"))], [["dp_next"], "evt_Next", true]);

  part("Another 400 is not taken for a missing payment: it waits");
  store = await setup(["dispute.opened"]);
  timeline = [evt("evt_Bad400", "charge.dispute.created", 1_790_080_000, dispute("dp_bad400", "pi_Member"))];
  failing["/v1/invoices/in_Member01"] = { left: 1, how: "400" };
  await watchStripe(Date.now() + 10_000);
  is("a 400 that is not resource_missing sends nothing and keeps no anchor past it", [await sentIds(store, "dispute.opened", "dispute"), await anchor(), await waitRecord()], [[], null, "evt_Bad400|1"]);
  await watchStripe(Date.now() + 10_000);
  is("and is sent once Stripe answers; the wait is let go", [await sentIds(store, "dispute.opened", "dispute"), await anchor(), await waitRecord()], [["dp_bad400"], "evt_Bad400", null]);

  part("A lookup Stripe keeps refusing waits a bounded number of runs, then is passed over loudly");
  store = await setup(["dispute.opened"]);
  // A paid plan, so the store has webhook deliveries this month for the line the passed-over event leaves.
  await setSubscription(OWNER, { customerId: "cus_SubDisputesPlan", subscriptionId: "sub_SubDisputesPlan", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  timeline = [
    evt("evt_KBefore", "charge.dispute.created", 1_790_090_000, dispute("dp_kbefore", "pi_Once")),
    evt("evt_Refused", "charge.dispute.created", 1_790_090_100, dispute("dp_refused", "pi_Member")),
    evt("evt_KAfter", "charge.dispute.created", 1_790_090_200, dispute("dp_kafter", "pi_Once")),
  ];
  failing["/v1/invoices/in_Member01"] = { left: 1_000_000, how: "403" };
  await watchStripe(Date.now() + 10_000);
  is("the first run sends what came before and counts one run of waiting", [await sentIds(store, "dispute.opened", "dispute"), await anchor(), await waitRecord()], [["dp_kbefore"], "evt_KBefore", "evt_Refused|1"]);
  // Two days go by: the anchor's expiry is renewed while it does not move (without it, 28 days would be left).
  redis.advance(2 * 86400 * 1000);
  await watchStripe(Date.now() + 10_000);
  is("each run it waits is counted", await waitRecord(), "evt_Refused|2");
  is("the anchor, not moving, is kept as long as Stripe keeps events", [await anchor(), (await anchorTtl()) > 29 * 86400], ["evt_KBefore", true]);
  // Jump to the last run before the cap.
  await redis.pipeline([["SET", `nl:hooks:wait:${statsId}`, `evt_Refused|${STRIPE_WAIT_RUNS - 1}`, "EX", 30 * 86400]]);
  await watchStripe(Date.now() + 10_000);
  is("still waiting at the last run before the cap", [await waitRecord(), await sentIds(store, "dispute.opened", "dispute")], [`evt_Refused|${STRIPE_WAIT_RUNS}`, ["dp_kbefore"]]);
  said.length = 0;
  asked.length = 0;
  const givingUp = await watchStripe(Date.now() + 10_000);
  is("past the cap it is passed over, asking Stripe nothing for it", lookups().map((a) => a.path), ["/v1/payment_intents/pi_Once"]);
  is("and it is not counted among the events read; the one after it is", givingUp.events, 1);
  const view = await webhooksView(store);
  const line = view.log.find((d) => d.givenUp);
  is("it leaves a line in the store's delivery log, which the studio shows", [line?.type, line?.state, line?.attempts, line?.endpoint], ["dispute.opened", "failed", 0, "hooks.example.net/in"]);
  is("saying what was skipped and where to look", [line?.lastError.includes("dispute dp_refused"), line?.lastError.includes(`after ${STRIPE_WAIT_RUNS} tries`), line?.lastError.includes("Stripe dashboard")], [true, true, true]);
  is("with nothing to send again by hand", (await resendDelivery(store, line?.id ?? "dlv_000000000000000000000000")).ok, false);
  is("and no message made of it", (await recentMessages(store, "dispute.opened", 10)).map((m) => (m.data as { dispute: string }).dispute).sort(), ["dp_kafter", "dp_kbefore"]);
  is("said loudly in the log", said.some((line) => line.startsWith("WEBHOOK EVENT GIVEN UP") && line.includes("evt_Refused")), true);
  is("what came after is sent, the anchor moves on and the wait is let go", [await sentIds(store, "dispute.opened", "dispute"), await anchor(), await waitRecord()], [["dp_kafter", "dp_kbefore"], "evt_KAfter", null]);
  store = await setup(["dispute.opened"]);
  timeline = [evt("evt_NoRoom", "charge.dispute.created", 1_790_095_000, dispute("dp_noroom", "pi_Member"))];
  failing["/v1/invoices/in_Member01"] = { left: 1_000_000, how: "403" };
  await redis.pipeline([["SET", `nl:hooks:wait:${statsId}`, `evt_NoRoom|${STRIPE_WAIT_RUNS}`, "EX", 30 * 86400]]);
  await watchStripe(Date.now() + 10_000);
  is("a store with no webhook delivery left this month: passed over, said in the server log only", [(await webhooksView(store)).log.some((d) => d.givenUp), said.some((l) => l.includes("could not be written in the store's log")), await anchor()], [false, true, "evt_NoRoom"]);
  is("about a day of five-minute runs", STRIPE_WAIT_RUNS * 5 / 60, 24);

  part("membership.canceled waits for the member's address instead of going out without it");
  store = await setup(["membership.canceled"]);
  timeline = Array.from({ length: STRIPE_LOOKUPS_PER_STORE + 1 }, (_, i) => {
    customers[`cus_Cancel${i}`] = `member${i}@example.net`;
    const e = cancel(i);
    (e.data as Record<string, unknown>).previous_attributes = cancelPrevious;
    return e;
  });
  const cancels = async () => (await recentMessages(store, "membership.canceled", 20)).map((m) => (m.data as { buyer: { email: string | null } }).buyer.email);
  await watchStripe(Date.now() + 10_000);
  is("past the budget the last one waits; none is sent without its address", [(await cancels()).length, (await cancels()).includes(null), await anchor()], [STRIPE_LOOKUPS_PER_STORE, false, `evt_Cancel${STRIPE_LOOKUPS_PER_STORE - 1}`]);
  is("said in the log", said.some((line) => line.includes("cancellations to look up")), true);
  await watchStripe(Date.now() + 10_000);
  is("the next run sends it with the address and moves the anchor on", [(await cancels()).includes(`member${STRIPE_LOOKUPS_PER_STORE}@example.net`), await anchor()], [true, `evt_Cancel${STRIPE_LOOKUPS_PER_STORE}`]);
  store = await setup(["membership.canceled"]);
  timeline = [cancel(0)];
  (timeline[0].data as Record<string, unknown>).previous_attributes = cancelPrevious;
  failing["/v1/customers/cus_Cancel0"] = { left: 1, how: "500" };
  await watchStripe(Date.now() + 10_000);
  is("an address that failed to load waits too", [(await cancels()).length, await waitRecord()], [0, "evt_Cancel0|1"]);
  await watchStripe(Date.now() + 10_000);
  is("and goes out with it next run", await cancels(), ["member0@example.net"]);
  store = await setup(["membership.canceled"]);
  timeline = [cancel(99)];
  (timeline[0].data as Record<string, unknown>).previous_attributes = cancelPrevious;
  await watchStripe(Date.now() + 10_000);
  is("a customer Stripe no longer has goes out without an address, not held", await cancels(), [null]);
  store = await setup(["membership.canceled"]);
  deletedCustomers.add("cus_Cancel98");
  timeline = [cancel(98)];
  (timeline[0].data as Record<string, unknown>).previous_attributes = cancelPrevious;
  await watchStripe(Date.now() + 10_000);
  is("a deleted customer (200, deleted: true) goes out without an address, and nothing waits", [await cancels(), await waitRecord(), await anchor()], [[null], null, "evt_Cancel98"]);

  part("Nothing is asked of Stripe, and nothing waits, for an event no endpoint hears");
  store = await setup(["sale.completed"]);
  failing["/v1/customers/cus_Cancel0"] = { left: 1_000_000, how: "500" };
  failing["/v1/invoices/in_Member01"] = { left: 1_000_000, how: "500" };
  const unheardCancel = cancel(0);
  (unheardCancel.data as Record<string, unknown>).previous_attributes = cancelPrevious;
  timeline = [
    unheardCancel,
    evt("evt_UnRefund", "charge.refunded", 1_790_100_100, refund("ch_unheard", "pi_Member")),
    evt("evt_UnDispute", "charge.dispute.created", 1_790_100_200, dispute("dp_unheard", "pi_Member")),
    evt("evt_Sale", "checkout.session.completed", 1_790_100_300, { id: "cs_Sale01", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 4900, currency: "usd", metadata: { store: HANDLE, product: "p_course" }, customer_details: { email: null, name: null } }),
  ];
  await watchStripe(Date.now() + 10_000);
  is("the sale goes out in the same run", (await recentMessages(store, "sale.completed", 10)).map((m) => (m.data as { checkout_session: string }).checkout_session), ["cs_Sale01"]);
  is("with no call about a customer, a payment or an invoice", lookups().map((a) => a.path), []);
  is("nothing waits and the anchor reaches the newest", [await waitRecord(), await anchor()], [null, "evt_Sale"]);

  part("Forgetting a store's webhooks forgets its wait too");
  await redis.pipeline([["SET", `nl:hooks:wait:${statsId}`, "evt_Any|3", "EX", 60]]);
  const { forgetStoreWebhooks } = await import("@/lib/webhooks");
  await forgetStoreWebhooks(statsId);
  is("no wait record left", await waitRecord(), null);

  part("The call budget per run is the same as before");
  is("ten calls for refunds and addresses, ten for disputes", [STRIPE_LOOKUPS_PER_STORE, DISPUTE_LOOKUPS_PER_STORE], [10, 10]);
  store = await setup(["dispute.opened", "refund.issued"]);
  timeline = [
    ...Array.from({ length: 6 }, (_, i) => evt(`evt_BudDp${i}`, "charge.dispute.created", 1_790_060_000 + i, dispute(`dp_bud${i}`, "pi_Member"))),
    ...Array.from({ length: 6 }, (_, i) => evt(`evt_BudRf${i}`, "charge.refunded", 1_790_061_000 + i, refund(`ch_bud${i}`, "pi_Member"))),
  ];
  let runs = 0;
  let most = 0;
  while ((await anchor()) !== "evt_BudRf5" && runs < 10) {
    asked.length = 0;
    await watchStripe(Date.now() + 10_000);
    most = Math.max(most, lookups().length);
    runs += 1;
  }
  is("no run asks Stripe more than ten plus ten times about payments", most <= STRIPE_LOOKUPS_PER_STORE + DISPUTE_LOOKUPS_PER_STORE, true);
  is("a backlog past the budget is worked through over runs, nothing lost", [await sentIds(store, "dispute.opened", "dispute"), await sentIds(store, "refund.issued", "charge")], [
    Array.from({ length: 6 }, (_, i) => `dp_bud${i}`),
    Array.from({ length: 6 }, (_, i) => `ch_bud${i}`),
  ]);
  is("in a bounded number of runs", runs <= 4, true);

  console.error = logged;
  done();
}

void main();
