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
type Failure = "500" | "network" | "403" | "400" | "429" | "html";
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
  is("a 400 that is not resource_missing sends nothing and keeps no anchor past it", [await sentIds(store, "dispute.opened", "dispute"), await anchor(), await waitOf()], [[], null, "evt_Bad400|1"]);
  await watchStripe(Date.now() + 10_000);
  is("and is sent once Stripe answers; the wait is let go", [await sentIds(store, "dispute.opened", "dispute"), await anchor(), await waitRecord()], [["dp_bad400"], "evt_Bad400", null]);

  part("A lookup that keeps failing waits a bounded number of visits, then is passed over loudly");
  store = await setup(["dispute.opened"]);
  // A paid plan, so the store's month's deliveries can be counted (a passed-over line takes none).
  await setSubscription(OWNER, { customerId: "cus_SubDisputesPlan", subscriptionId: "sub_SubDisputesPlan", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  store = (await storeForEmail(OWNER))!;
  timeline = [
    evt("evt_KBefore", "charge.dispute.created", 1_790_090_000, dispute("dp_kbefore", "pi_Once")),
    evt("evt_Refused", "charge.dispute.created", 1_790_090_100, dispute("dp_refused", "pi_Member")),
    evt("evt_KAfter", "charge.dispute.created", 1_790_090_200, dispute("dp_kafter", "pi_Once")),
  ];
  // A failure that may clear (a 500): the long wait.
  failing["/v1/invoices/in_Member01"] = { left: 1_000_000, how: "500" };
  const usedBeforeDispute = await allowanceUsed(store, "webhook");
  await watchStripe(Date.now() + 10_000);
  is("the first visit sends what came before and counts one visit of waiting, with when it began", [await sentIds(store, "dispute.opened", "dispute"), await anchor(), await waitOf(), Math.abs(Number(String(await waitRecord()).split("|")[2]) - nowSeconds()) < 60], [["dp_kbefore"], "evt_KBefore", "evt_Refused|1", true]);
  // Two days go by, for the job and for the store: the anchor's expiry is renewed while it does not move (without it, 28 days
  // would be left), and with only two failed visits the time bound does not apply yet (STRIPE_WAIT_TIME_VISITS).
  redis.advance(2 * 86400 * 1000);
  await watchStripe(Date.now() + 10_000, Date.now() + 2 * 86400 * 1000 + 60_000);
  is("each visit it waits is counted; two days with two visits is not enough to give up", await waitOf(), "evt_Refused|2");
  is("the anchor, not moving, is kept as long as Stripe keeps events", [await anchor(), (await anchorTtl()) > 29 * 86400], ["evt_KBefore", true]);
  // Jump to two visits before the cap.
  await redis.pipeline([["SET", `nl:hooks:wait:${statsId}`, `evt_Refused|${STRIPE_WAIT_RUNS - 2}|${nowSeconds()}`, "EX", 30 * 86400]]);
  await watchStripe(Date.now() + 10_000);
  is("still waiting one visit before the cap", [await waitOf(), await sentIds(store, "dispute.opened", "dispute")], [`evt_Refused|${STRIPE_WAIT_RUNS - 1}`, ["dp_kbefore"]]);
  said.length = 0;
  asked.length = 0;
  const givingUp = await watchStripe(Date.now() + 10_000);
  is("the visit that reaches the cap tries once more, then passes it over", lookups().map((a) => a.path), ["/v1/payment_intents/pi_Member", "/v1/invoice_payments?pi_Member", "/v1/invoices/in_Member01", "/v1/payment_intents/pi_Once"]);
  is("and it is not counted among the events read; the one after it is", givingUp.events, 1);
  const view = await webhooksView(store);
  const line = view.log.find((d) => d.givenUp);
  is("it leaves a line in the store's delivery log, which the studio shows", [line?.type, line?.state, line?.attempts, line?.endpoint], ["dispute.opened", "failed", 0, "hooks.example.net/in"]);
  is("saying what was skipped and where to look, without repeating the label", [line?.lastError.startsWith("Stripe kept refusing or failing to answer about dispute dp_refused"), line?.lastError.includes(`after ${STRIPE_WAIT_RUNS} tries`), line?.lastError.includes("Stripe dashboard"), line?.lastError.includes("Not sent")], [true, true, true, false]);
  is("a dispute may not be the store's: the line says so and takes none of its deliveries", [line?.lastError.includes("It may not be from this store."), await allowanceUsed(store, "webhook")], [true, usedBeforeDispute]);
  is("with nothing to send again by hand", (await resendDelivery(store, line?.id ?? "dlv_000000000000000000000000")).ok, false);
  is("and no message made of it", (await recentMessages(store, "dispute.opened", 10)).map((m) => (m.data as { dispute: string }).dispute).sort(), ["dp_kafter", "dp_kbefore"]);
  is("said loudly in the log", said.some((line) => line.startsWith("WEBHOOK EVENT GIVEN UP") && line.includes("evt_Refused")), true);
  is("what came after is sent, the anchor moves on and the wait is let go", [await sentIds(store, "dispute.opened", "dispute"), await anchor(), await waitRecord()], [["dp_kafter", "dp_kbefore"], "evt_KAfter", null]);
  is("about a day of five-minute visits", STRIPE_WAIT_RUNS * 5 / 60, 24);

  part("A store visited seldom gives up by time, long before Stripe's thirty days");
  store = await setup(["dispute.opened"]);
  timeline = [
    evt("evt_Slow", "charge.dispute.created", 1_790_091_000, dispute("dp_slow", "pi_Member")),
    evt("evt_SlowAfter", "charge.dispute.created", 1_790_091_100, dispute("dp_slowafter", "pi_Once")),
  ];
  failing["/v1/invoices/in_Member01"] = { left: 1_000_000, how: "500" };
  // Visited every few hours: only five visits so far, the first two days and a minute ago.
  await redis.pipeline([["SET", `nl:hooks:wait:${statsId}`, `evt_Slow|5|${nowSeconds() - STRIPE_WAIT_MAX_SECONDS - 60}`, "EX", 30 * 86400]]);
  await watchStripe(Date.now() + 10_000);
  is("two days after it first stopped, it is passed over with its line, and the next is sent", [(await webhooksView(store)).log.filter((d) => d.givenUp).length, await sentIds(store, "dispute.opened", "dispute"), await anchor(), await waitRecord()], [1, ["dp_slowafter"], "evt_SlowAfter", null]);
  store = await setup(["dispute.opened"]);
  timeline = [evt("evt_Slow2", "charge.dispute.created", 1_790_091_200, dispute("dp_slow2", "pi_Member"))];
  failing["/v1/invoices/in_Member01"] = { left: 1_000_000, how: "500" };
  await redis.pipeline([["SET", `nl:hooks:wait:${statsId}`, `evt_Slow2|5|${nowSeconds() - STRIPE_WAIT_MAX_SECONDS + 3600}`, "EX", 30 * 86400]]);
  await watchStripe(Date.now() + 10_000);
  is("an hour short of two days it still waits", await waitOf(), "evt_Slow2|6");
  store = await setup(["dispute.opened"]);
  timeline = [evt("evt_AfterPause", "charge.dispute.created", 1_790_091_300, dispute("dp_afterpause", "pi_Member"))];
  failing["/v1/invoices/in_Member01"] = { left: 1_000_000, how: "500" };
  // First stopped a week ago, then the plan's costs were paused: one failed visit only.
  await redis.pipeline([["SET", `nl:hooks:wait:${statsId}`, `evt_AfterPause|1|${nowSeconds() - 7 * 86400}`, "EX", 30 * 86400]]);
  for (let visit = 2; visit < STRIPE_WAIT_TIME_VISITS; visit += 1) await watchStripe(Date.now() + 10_000);
  is(`after a long pause it still gets tries: waiting at ${STRIPE_WAIT_TIME_VISITS - 1} visits, no line`, [await waitOf(), (await webhooksView(store)).log.some((d) => d.givenUp)], [`evt_AfterPause|${STRIPE_WAIT_TIME_VISITS - 1}`, false]);
  await watchStripe(Date.now() + 10_000);
  is(`and is passed over at ${STRIPE_WAIT_TIME_VISITS}`, [await waitRecord(), (await webhooksView(store)).log.some((d) => d.givenUp)], [null, true]);

  part("Stripe refusing the request itself gives up after a few visits; a limit keeps the long wait");
  for (const [how, code] of [["400", "parameter_unknown"], ["403", "account_invalid"]] as const) {
    store = await setup(["dispute.opened"]);
    timeline = [
      evt("evt_Ref4xx", "charge.dispute.created", 1_790_092_000, dispute("dp_ref4xx", "pi_Member")),
      evt("evt_Ref4xxAfter", "charge.dispute.created", 1_790_092_100, dispute("dp_ref4xxafter", "pi_Once")),
    ];
    failing["/v1/invoice_payments?pi_Member"] = { left: 1_000_000, how };
    for (let visit = 1; visit < STRIPE_REFUSED_RUNS; visit += 1) await watchStripe(Date.now() + 10_000);
    is(`${how} ${code}: waits ${STRIPE_REFUSED_RUNS - 1} visits`, [await waitOf(), await sentIds(store, "dispute.opened", "dispute")], [`evt_Ref4xx|${STRIPE_REFUSED_RUNS - 1}`, []]);
    await watchStripe(Date.now() + 10_000);
    is(`${how} ${code}: passed over on visit ${STRIPE_REFUSED_RUNS}, with its line; the next is sent`, [(await webhooksView(store)).log.filter((d) => d.givenUp).length, await sentIds(store, "dispute.opened", "dispute"), await waitRecord()], [1, ["dp_ref4xxafter"], null]);
  }
  store = await setup(["dispute.opened"]);
  timeline = [evt("evt_Limited", "charge.dispute.created", 1_790_093_000, dispute("dp_limited", "pi_Member"))];
  failing["/v1/invoice_payments?pi_Member"] = { left: 1_000_000, how: "429" };
  for (let visit = 0; visit < STRIPE_REFUSED_RUNS + 2; visit += 1) await watchStripe(Date.now() + 10_000);
  is("429: still waiting after more visits than a refusal gets", [await waitOf(), (await webhooksView(store)).log.some((d) => d.givenUp)], [`evt_Limited|${STRIPE_REFUSED_RUNS + 2}`, false]);

  part("A failure inside one event's handling is counted too, and ends in a give-up");
  store = await setup(["sale.completed"]);
  const brokenSale = evt("evt_Broken", "checkout.session.completed", 1_790_094_000, { id: "cs_Broken01", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 4900, currency: "usd", metadata: { store: HANDLE, product: "p_course" }, customer_details: { email: null, name: null } });
  const nextSale = evt("evt_NextSale", "checkout.session.completed", 1_790_094_100, { id: "cs_Next01", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 4900, currency: "usd", metadata: { store: HANDLE, product: "p_course" }, customer_details: { email: null, name: null } });
  timeline = [brokenSale, nextSale];
  const brokenMark = `nl:hooks:evt:${eventIdFor(statsId, "sale.completed", "cs_Broken01")}`;
  const realPipelineEarly = redis.pipeline.bind(redis);
  redis.pipeline = ((commands: (string | number)[][]) => (commands.some((c) => c[0] === "SET" && c[1] === brokenMark) ? Promise.reject(new Error("synthetic store failure")) : realPipelineEarly(commands))) as typeof redis.pipeline;
  await watchStripe(Date.now() + 10_000);
  is("the visit is not lost: the event waits, counted, and the anchor stays before it", [await waitOf(), await anchor(), (await recentMessages(store, "sale.completed")).length], ["evt_Broken|1", null, 0]);
  await redis.pipeline([["SET", `nl:hooks:wait:${statsId}`, `evt_Broken|${STRIPE_WAIT_RUNS - 1}|${nowSeconds()}`, "EX", 30 * 86400]]);
  await watchStripe(Date.now() + 10_000);
  redis.pipeline = realPipelineEarly as typeof redis.pipeline;
  is("at the cap it is passed over and the next one is sent", [await waitRecord(), await anchor(), (await recentMessages(store, "sale.completed")).map((m) => (m.data as { checkout_session: string }).checkout_session)], [null, "evt_NextSale", ["cs_Next01"]]);
  const ours = (await webhooksView(store)).log.find((d) => d.givenUp);
  is("a sale gets its line too, saying honestly the failure was ours", [ours?.type, ours?.lastError.startsWith("We could not process this Stripe event about checkout cs_Broken01"), ours?.lastError.includes("may not be")], ["sale.completed", true, false]);
  is("our failure is logged apart from Stripe's", said.some((l) => l.startsWith("OUR CODE FAILED") && l.includes("evt_Broken")), true);

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
  is("an address that failed to load waits too", [(await cancels()).length, await waitOf()], [0, "evt_Cancel0|1"]);
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

  part("While the plan's costs are paused, the wait is kept with the anchor");
  store = await setup(["dispute.opened"]);
  await setSubscription(OWNER, { customerId: "cus_SubDisputesPaused", subscriptionId: "sub_SubDisputesPaused", active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
  await redis.pipeline([["SET", `nl:hooks:anchor:${statsId}`, "evt_Paused01", "EX", 60], ["SET", `nl:hooks:wait:${statsId}`, `evt_Paused02|4|${nowSeconds()}`, "EX", 60]]);
  asked.length = 0;
  await watchStripe(Date.now() + 10_000);
  const pausedTtls = (await redis.pipeline([["TTL", `nl:hooks:anchor:${statsId}`], ["TTL", `nl:hooks:wait:${statsId}`]])).map(Number);
  is("nothing asked of Stripe; the anchor and the wait both kept thirty days", [asked.length, pausedTtls.every((ttl) => ttl > 29 * 86400), await waitOf()], [0, true, "evt_Paused02|4"]);

  part("Forgetting a store's webhooks forgets its wait too");
  const today = Math.floor(Date.now() / 86_400_000);
  const endpointId = (await webhooksView(store)).endpoints[0]?.id ?? "";
  const dayKeys = [today, today - 1, today - 2].map((d) => `nl:hooks:wait:${statsId}:day:${d}:${endpointId}`);
  await redis.pipeline([["SET", `nl:hooks:wait:${statsId}`, "evt_Any|3", "EX", 60], ...dayKeys.map((k) => ["ZADD", k, 1, "evt_x"])]);
  const { forgetStoreWebhooks } = await import("@/lib/webhooks");
  await forgetStoreWebhooks(statsId);
  is("no wait record left", await waitRecord(), null);
  is("no day's set of passed-over events left, today's or the two before", (await redis.pipeline(dayKeys.map((k) => ["ZCARD", k]))).map(Number), [0, 0, 0]);

  part("A given-up line takes no delivery, is written once and never lost");
  const givenUpLines = async () => (await webhooksView(store)).log.filter((d) => d.givenUp);
  const seedWait = (evtId: string) => redis.pipeline([["SET", `nl:hooks:wait:${statsId}`, `${evtId}|${STRIPE_WAIT_RUNS}`, "EX", 30 * 86400]]);
  // A paid plan, and the store read again with it, so its month's deliveries can be counted.
  const paid = async () => {
    await setSubscription(OWNER, { customerId: "cus_SubDisputesPlan", subscriptionId: "sub_SubDisputesPlan", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    return (await storeForEmail(OWNER))!;
  };
  const heldCancel = (n: number) => ({ ...cancel(n), data: { object: cancel(n).data.object, previous_attributes: cancelPrevious } });
  const realPipeline = redis.pipeline.bind(redis);
  const breakWhen = (bad: (command: (string | number)[]) => boolean) => {
    redis.pipeline = ((commands: (string | number)[][]) => (commands.some(bad) ? Promise.reject(new Error("synthetic store failure")) : realPipeline(commands))) as typeof redis.pipeline;
  };
  const mend = () => { redis.pipeline = realPipeline as typeof redis.pipeline; };

  store = await setup(["membership.canceled", "sale.completed"]);
  store = await paid();
  failing["/v1/customers/cus_Cancel0"] = { left: 1_000_000, how: "403" };
  const sale = evt("evt_SaleAfter", "checkout.session.completed", 1_790_110_000, { id: "cs_Throw01", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 4900, currency: "usd", metadata: { store: HANDLE, product: "p_course" }, customer_details: { email: null, name: null } });
  timeline = [heldCancel(0), sale];
  await seedWait("evt_Cancel0");
  const used0 = await allowanceUsed(store, "webhook");
  // The visit dies on the store after giving up, before its anchor and its wait are written.
  breakWhen((command) => command[0] === "SET" && command[1] === `nl:hooks:anchor:${statsId}`);
  await watchStripe(Date.now() + 10_000);
  mend();
  is("a visit that gives up and then dies: one line, no delivery taken, the wait still at the cap", [(await givenUpLines()).length, (await allowanceUsed(store, "webhook")) - used0, await waitOf(), await anchor()], [1, 0, `evt_Cancel0|${STRIPE_WAIT_RUNS}`, null]);
  is("a known event's line does not say it may not be the store's", (await givenUpLines())[0]?.lastError.includes("may not be"), false);
  await watchStripe(Date.now() + 10_000);
  is("the next visit gives up again but writes nothing more, and sends the sale", [(await givenUpLines()).length, (await allowanceUsed(store, "webhook")) - used0, (await recentMessages(store, "sale.completed")).length, await anchor(), await waitRecord()], [1, 0, 1, "evt_SaleAfter", null]);
  // A week and a day later the line itself is gone; then Stripe loses the anchor, everything is read
  // again from far back and the same event waits to the cap again: only the event's mark says it was told.
  redis.advance(8 * 86400 * 1000);
  is("the line has expired after its week", (await givenUpLines()).length, 0);
  await redis.pipeline([["DEL", `nl:hooks:anchor:${statsId}`]]);
  await seedWait("evt_Cancel0");
  await watchStripe(Date.now() + 10_000);
  is("read again from far back and given up again: the mark holds, no line written again, no delivery", [(await givenUpLines()).length, (await allowanceUsed(store, "webhook")) - used0, await waitRecord()], [0, 0, null]);

  part("Past the day's own lines, one summary line counts the rest; each event is counted once");
  store = await setup(["dispute.opened"]);
  failing["/v1/invoices/in_Member01"] = { left: 1_000_000, how: "500" };
  timeline = [];
  const today0 = Math.floor(Date.now() / 86_400_000);
  const dayKey = `nl:hooks:wait:${statsId}:day:${today0}:${(await webhooksView(store)).endpoints[0]?.id}`;
  const dayCount = async () => Number((await redis.pipeline([["ZCARD", dayKey]]))[0]);
  const summary = async () => (await givenUpLines()).filter((d) => d.lastError.includes("more Stripe"));
  const date = new Date(today0 * 86_400_000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  for (let n = 0; n < GIVEN_UP_LINES_PER_DAY + 2; n += 1) {
    timeline = [...timeline, evt(`evt_Day${n}`, "charge.dispute.created", 1_790_120_000 + n, dispute(`dp_day${n}`, "pi_Member"))];
    await seedWait(`evt_Day${n}`);
    if (n === 0) {
      // The first dies after it was counted, before its line is written: counted once, its line written next visit.
      breakWhen((command) => command[0] === "SET" && String(command[1]).startsWith("nl:hooks:d:"));
      await watchStripe(Date.now() + 10_000);
      mend();
      is("a visit dying between the day's count and the line leaves it counted, waiting", [await dayCount(), (await givenUpLines()).length, await waitOf()], [1, 0, `evt_Day0|${STRIPE_WAIT_RUNS}`]);
    }
    await watchStripe(Date.now() + 10_000);
    if (n === GIVEN_UP_LINES_PER_DAY) is("the first past the cap: a summary line saying one more, on which day", (await summary()).map((d) => d.lastError), [`1 more Stripe event could not be processed on ${date}. Look it up in your Stripe dashboard.`]);
  }
  const firstSummary = (await summary())[0];
  is(`${GIVEN_UP_LINES_PER_DAY} own lines and one summary whose count rose, generic for every kind of event`, [(await givenUpLines()).length - (await summary()).length, (await summary()).map((d) => d.lastError)], [GIVEN_UP_LINES_PER_DAY, [`2 more Stripe events could not be processed on ${date}. Look them up in your Stripe dashboard.`]]);
  is("every event counted once, the anchor past them all", [await dayCount(), await anchor()], [GIVEN_UP_LINES_PER_DAY + 2, `evt_Day${GIVEN_UP_LINES_PER_DAY + 1}`]);
  const ttl = Number((await redis.pipeline([["TTL", dayKey]]))[0]);
  is("the day's set is gone at the end of the next UTC day", ttl > 0 && ttl <= (today0 + 2) * 86400 - nowSeconds() + 5, true);

  // Stripe lost the anchor: everything is read again from far back. What was passed over is passed over at once, not held again.
  await redis.pipeline([["DEL", `nl:hooks:anchor:${statsId}`]]);
  asked.length = 0;
  await watchStripe(Date.now() + 10_000);
  is("read again: every passed-over event (own line or summary) skipped at once, nothing asked of Stripe", [lookups().length, await anchor(), await waitRecord(), await dayCount()], [0, `evt_Day${GIVEN_UP_LINES_PER_DAY + 1}`, null, GIVEN_UP_LINES_PER_DAY + 2]);
  // An event whose mark and own line were both lost keeps its first place in the day (ZADD NX): it gets its own line back, not the summary.
  const lostLine = (await givenUpLines()).find((d) => d.lastError.includes("dispute dp_day1"));
  await redis.pipeline([["DEL", `nl:hooks:evt:${eventIdFor(statsId, "stripe.given_up", "evt_Day1")}`], ["DEL", `nl:hooks:d:${lostLine?.id}`], ["DEL", `nl:hooks:anchor:${statsId}`]]);
  await seedWait("evt_Day1");
  await watchStripe(Date.now() + 10_000);
  const after = await givenUpLines();
  is("its own line again, the summary unchanged, the count the same", [after.some((d) => d.lastError.includes("dispute dp_day1")), (await summary()).map((d) => d.lastError.split(" ")[0]), await dayCount()], [true, ["2"], GIVEN_UP_LINES_PER_DAY + 2]);
  is("the summary keeps when it was first written and what it was said as", [(await summary())[0]?.createdAt, (await summary())[0]?.type], [firstSummary?.createdAt, firstSummary?.type]);

  for (const [what, bad] of [
    ["the line written, the log not", (command: (string | number)[]) => command[0] === "LPUSH" && command[1] === `nl:hooks:log:${statsId}`],
    ["the lines and the log written, the event's mark not", (command: (string | number)[]) => command[0] === "SET" && String(command[1]).startsWith("nl:hooks:evt:") && command[3] === "EX"],
  ] as const) {
    store = await setup(["membership.canceled"]);
    failing["/v1/customers/cus_Cancel3"] = { left: 1_000_000, how: "403" };
    timeline = [heldCancel(3)];
    await seedWait("evt_Cancel3");
    breakWhen((command) => bad(command));
    await watchStripe(Date.now() + 10_000);
    mend();
    is(`${what}: the visit dies and the event still waits at the cap`, [await waitRecord(), await anchor()], [`evt_Cancel3|${STRIPE_WAIT_RUNS}`, null]);
    await watchStripe(Date.now() + 10_000);
    is(`${what}: the next visit leaves exactly one line in the log and moves on`, [(await givenUpLines()).length, await anchor(), await waitRecord()], [1, "evt_Cancel3", null]);
  }

  store = await setup(["membership.canceled"]);
  store = await paid();
  is("a second endpoint that hears something else is kept", (await addEndpoint(store, "https://hooks.example.org/sales", ["sale.completed"])).ok, true);
  failing["/v1/customers/cus_Cancel1"] = { left: 1_000_000, how: "403" };
  timeline = [heldCancel(1)];
  await seedWait("evt_Cancel1");
  const used1 = await allowanceUsed(store, "webhook");
  await watchStripe(Date.now() + 10_000);
  is("two endpoints, one hearing it: one line, for that one, and no delivery taken", [(await givenUpLines()).map((d) => d.endpoint), (await allowanceUsed(store, "webhook")) - used1], [["hooks.example.net/in"], 0]);

  store = await setup(["membership.canceled"]);
  failing["/v1/customers/cus_Cancel2"] = { left: 1_000_000, how: "403" };
  timeline = [heldCancel(2)];
  await seedWait("evt_Cancel2");
  // An endpoint added while the visit is under way, after the visit read the store's endpoints.
  duringEvents = () => addEndpoint(store, "https://hooks.example.org/late", ["membership.canceled"]);
  await watchStripe(Date.now() + 10_000);
  is("an endpoint added during the visit gets its line too", (await givenUpLines()).map((d) => d.endpoint).sort(), ["hooks.example.net/in", "hooks.example.org/late"]);

  part("A line says only what was not sent, and whose the failure was");
  store = await setup(["sale.completed", "membership.started"]);
  is("a second endpoint hearing only sales is kept", (await addEndpoint(store, "https://hooks.example.org/sales-only", ["sale.completed"])).ok, true);
  const subCheckout = evt("evt_SubCheckout", "checkout.session.completed", 1_790_130_000, { id: "cs_Sub01", object: "checkout.session", status: "complete", payment_status: "paid", mode: "subscription", subscription: "sub_Started01", amount_total: 2900, currency: "usd", metadata: { store: HANDLE, product: "p_member" }, customer_details: { email: null, name: null } });
  timeline = [subCheckout];
  // The sale goes out; the membership's start fails on the store every time.
  const startedMark = `nl:hooks:evt:${eventIdFor(statsId, "membership.started", "sub_Started01")}`;
  breakWhen((command) => command[0] === "SET" && command[1] === startedMark);
  await watchStripe(Date.now() + 10_000);
  is("the sale went out to both; the start waits, counted as ours", [(await recentMessages(store, "sale.completed")).length, await waitOf()], [1, "evt_SubCheckout|1"]);
  await seedWait("evt_SubCheckout");
  await watchStripe(Date.now() + 10_000);
  mend();
  const subLines = await givenUpLines();
  is("passed over: one line, typed membership.started, for the endpoint that hears it; none for the one that got its sale", subLines.map((d) => [d.type, d.endpoint]), [["membership.started", "hooks.example.net/in"]]);
  is("and it says the failure was ours", subLines[0]?.lastError.startsWith("We could not process this Stripe event about checkout cs_Sub01"), true);

  store = await setup(["membership.changed", "membership.canceled"]);
  const changeAndEnd = evt("evt_ChangeEnd", "customer.subscription.updated", 1_790_131_000, { id: "sub_ChangeEnd", object: "subscription", customer: "cus_ChangeEnd", cancel_at_period_end: true, current_period_end: 1_792_000_000, items: { data: [{ id: "si_1", quantity: 1, price: { id: "price_low", unit_amount: 900, recurring: { interval: "month", interval_count: 1 } } }] }, metadata: { store: HANDLE, product: "p_member" } });
  (changeAndEnd.data as Record<string, unknown>).previous_attributes = { cancel_at_period_end: false, items: { data: [{ id: "si_1", quantity: 1, price: { id: "price_high", unit_amount: 1900, recurring: { interval: "month", interval_count: 1 } } }] } };
  timeline = [changeAndEnd];
  failing["/v1/customers/cus_ChangeEnd"] = { left: 1_000_000, how: "403" };
  for (let visit = 0; visit < STRIPE_REFUSED_RUNS; visit += 1) await watchStripe(Date.now() + 10_000);
  const endLines = await givenUpLines();
  is("the change went out; the cancellation, refused by Stripe, is the one said not sent", [(await recentMessages(store, "membership.changed")).length, endLines.map((d) => d.type), endLines[0]?.lastError.startsWith("Stripe kept refusing or failing to answer about subscription sub_ChangeEnd")], [1, ["membership.canceled"], true]);

  store = await setup(["dispute.opened"]);
  oddShape.add("pi_Member");
  timeline = [evt("evt_OddShape", "charge.dispute.created", 1_790_132_000, dispute("dp_oddshape", "pi_Member"))];
  await seedWait("evt_OddShape");
  await watchStripe(Date.now() + 10_000);
  oddShape.delete("pi_Member");
  is("an answer in a shape the code does not know is our failure, said so", [(await givenUpLines())[0]?.lastError.startsWith("We could not process this Stripe event about dispute dp_oddshape"), said.some((l) => l.startsWith("OUR CODE FAILED telling whose a payment is"))], [true, true]);

  store = await setup(["dispute.opened"]);
  timeline = [evt("evt_Confirmed", "charge.dispute.created", 1_790_133_000, dispute("dp_confirmed", "pi_Once"))];
  // Its payment is the store's (a one-off checkout); sending it then fails on the store.
  const confirmedMark = `nl:hooks:evt:${eventIdFor(statsId, "dispute.opened", "dp_confirmed")}`;
  breakWhen((command) => command[0] === "SET" && command[1] === confirmedMark);
  await seedWait("evt_Confirmed");
  await watchStripe(Date.now() + 10_000);
  mend();
  is("a dispute confirmed as the store's does not say it may not be from this store", [(await givenUpLines()).length, (await givenUpLines())[0]?.lastError.includes("may not be")], [1, false]);

  part("An event is never marked sent without its deliveries");
  store = await setup(["sale.completed"]);
  timeline = [evt("evt_Queued", "checkout.session.completed", 1_790_134_000, { id: "cs_Queued01", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 4900, currency: "usd", metadata: { store: HANDLE, product: "p_course" }, customer_details: { email: null, name: null } })];
  const queuedMark = `nl:hooks:evt:${eventIdFor(statsId, "sale.completed", "cs_Queued01")}`;
  breakWhen((command) => command[0] === "ZADD" && command[1] === "nl:hooks:q");
  await watchStripe(Date.now() + 10_000);
  mend();
  is("the deliveries could not be written: no mark left, nothing in the log, the event waits", [(await redis.pipeline([["GET", queuedMark]]))[0], (await webhooksView(store)).log.length, await waitOf()], [null, 0, "evt_Queued|1"]);
  await watchStripe(Date.now() + 10_000);
  is("and the next visit sends it", [(await recentMessages(store, "sale.completed")).length, await waitRecord()], [1, null]);

  part("A delivery whose write's reply was lost is written again to the same delivery, never twice");
  // Runs the pipeline, then loses its reply, the first time `bad` matches it.
  const loseReplyOnce = (bad: (command: (string | number)[]) => boolean) => {
    let lost = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const reply = await realPipeline(commands);
      if (!lost && commands.some(bad)) {
        lost = true;
        throw new TypeError("fetch failed");
      }
      return reply;
    }) as typeof redis.pipeline;
  };
  const queued = async () => ((await redis.pipeline([["ZRANGEBYSCORE", "nl:hooks:q", "-inf", "+inf"]]))[0] as string[]).filter((m) => m.startsWith(`${statsId}|`));
  for (const [what, bad] of [
    ["the deliveries written", (command: (string | number)[]) => command[0] === "SET" && String(command[1]).startsWith("nl:hooks:d:") && command[3] === "NX"],
    ["the deliveries queued", (command: (string | number)[]) => command[0] === "ZADD" && command[1] === "nl:hooks:q"],
    ["the deliveries in the log", (command: (string | number)[]) => command[0] === "LPUSH"],
  ] as const) {
    store = await setup(["sale.completed"]);
    is(`${what}: a second endpoint is kept`, (await addEndpoint(store, "https://hooks.example.org/two", ["sale.completed"])).ok, true);
    timeline = [evt("evt_LostReply", "checkout.session.completed", 1_790_140_000, { id: "cs_LostReply01", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 4900, currency: "usd", metadata: { store: HANDLE, product: "p_course" }, customer_details: { email: null, name: null } })];
    loseReplyOnce(bad);
    await watchStripe(Date.now() + 10_000);
    mend();
    is(`${what}, the reply lost: the event waits for the next visit`, await waitOf(), "evt_LostReply|1");
    await watchStripe(Date.now() + 10_000);
    const log = (await webhooksView(store)).log;
    is(`${what}, the reply lost: exactly one delivery an endpoint in the log and on the queue after the next visit`, [log.length, new Set(log.map((d) => d.id)).size, log.map((d) => d.endpoint).sort(), (await queued()).length, await waitRecord()], [2, 2, ["hooks.example.net/in", "hooks.example.org/two"], 2, null]);
  }
  store = await setup(["sale.completed"]);
  timeline = [evt("evt_Lost", "checkout.session.completed", 1_790_141_000, { id: "cs_Lost01", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 4900, currency: "usd", metadata: { store: HANDLE, product: "p_course" }, customer_details: { email: null, name: null } })];
  const lostMark = `nl:hooks:evt:${eventIdFor(statsId, "sale.completed", "cs_Lost01")}`;
  breakWhen((command) => (command[0] === "ZADD" && command[1] === "nl:hooks:q") || (command[0] === "DEL" && command[1] === lostMark));
  await watchStripe(Date.now() + 10_000);
  mend();
  is("when the mark cannot be taken back either, the lost event is said loudly", said.some((l) => l.startsWith("WEBHOOK EVENT LOST") && l.includes("sale.completed")), true);

  part("An answer that is not JSON is Stripe's passing failure, not ours");
  store = await setup(["dispute.opened"]);
  timeline = [evt("evt_Html", "charge.dispute.created", 1_790_142_000, dispute("dp_html", "pi_Member"))];
  failing["/v1/invoices/in_Member01"] = { left: 1_000_000, how: "html" };
  for (let visit = 0; visit < STRIPE_REFUSED_RUNS + 1; visit += 1) await watchStripe(Date.now() + 10_000);
  is("still waiting past a refusal's visits, with no line", [await waitOf(), (await givenUpLines()).length], [`evt_Html|${STRIPE_REFUSED_RUNS + 1}`, 0]);
  await seedWait("evt_Html");
  await watchStripe(Date.now() + 10_000);
  is("passed over at the cap as Stripe's failure", (await givenUpLines())[0]?.lastError.startsWith("Stripe kept refusing or failing to answer about dispute dp_html"), true);

  part("At most MAX_ENDPOINTS endpoints a store a day are told, however they are removed and added");
  store = await setup(["dispute.opened"]);
  failing["/v1/invoices/in_Member01"] = { left: 1_000_000, how: "500" };
  timeline = [];
  const removed: string[] = [];
  for (let n = 0; n <= MAX_ENDPOINTS; n += 1) {
    if (n > 0) {
      const old = (await webhooksView(store)).endpoints[0];
      removed.push(old.id);
      is(`endpoint ${n + 1} is added`, (await addEndpoint(store, `https://hooks.example.org/turn${n}`, ["dispute.opened"])).ok, true);
      await removeEndpoint(store, old.id);
    }
    timeline = [...timeline, evt(`evt_Turn${n}`, "charge.dispute.created", 1_790_143_000 + n, dispute(`dp_turn${n}`, "pi_Member"))];
    await seedWait(`evt_Turn${n}`);
    await watchStripe(Date.now() + 10_000);
  }
  is(`${MAX_ENDPOINTS} endpoints told, the one past them in the server log only`, [(await givenUpLines()).length, said.some((l) => l.startsWith("more endpoints of a store were to be told")), await anchor()], [MAX_ENDPOINTS, true, `evt_Turn${MAX_ENDPOINTS}`]);
  const turnToday = Math.floor(Date.now() / 86_400_000);
  is("removing an endpoint took its day set with it", (await redis.pipeline(removed.map((id) => ["EXISTS", `nl:hooks:wait:${statsId}:day:${turnToday}:${id}`]))).map(Number), removed.map(() => 0));

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
