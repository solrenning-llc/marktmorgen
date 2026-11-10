/**
 * CX-123 rule 24 for the platform subscription's plan line (lib/billing.ts
 * stateOf/planOf). A subscription in good standing is read as a plan only
 * when Stripe's reply carries it in its exact shape: `items.data` a list of
 * exactly one line, its price with a whole positive `unit_amount` and a
 * `recurring.interval` of month or year (agreeing with a named price), and
 * typed `cancel_at` (null or a time) and `cancel_at_period_end` (a boolean).
 * A line Stripe sends with a quantity other than 1, a currency other than
 * USD or an interval_count other than 1 is off the plan's design (every
 * plan price is made by ensurePrice that way) and is unknown too.
 * Any other 200 reply is "unknown", and every caller keeps what the store has
 * written down: no write to the lowest plan, monthly, with no period
 * (readSubscription → recordState, the daily sync's applyListed and
 * refreshPeriod), no "ended" write after a cancellation reply
 * (setCancelAtPeriodEnd), no write after a checkout return
 * (readStartedSubscription) and no adoption or "lapsed" end from a search row
 * (findStoreSubscriptions). Healthy replies, named and legacy unnamed prices,
 * trials and terminal statuses read exactly as before. Stripe is a stand-in;
 * synthetic data only.
 */
import {
  findStoreSubscriptions,
  planOf,
  readStartedSubscription,
  readSubscription,
  setCancelAtPeriodEnd,
  stateOf,
} from "@/lib/billing";
import { recordState, refreshPeriod, syncSubscriptions } from "@/lib/billing-sync";
import { LEGACY_PLAN_PRICES, PLAN_PRICES } from "@/lib/plan";
import { claimHandle, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_billing_state_exact";
delete process.env.STRIPE_CONNECT_API_BASE;

const SUB = "sub_ExactScale0001";
const CUSTOMER = "cus_ExactScale01";
const SESSION = "cs_test_ExactScale000001";
const OWNER = "exact-state@example.com";
const HANDLE = "exactstate";

type Reply = Record<string, unknown>;
let subscriptionReply: unknown = {};
let postReply: unknown = {};
let sessionReply: unknown = {};
let searchPage: unknown = { object: "search_result", data: [], has_more: false, next_page: null };
let listPage: unknown = { object: "list", data: [], has_more: false };
let requests = 0;
let posts = 0;
let deletes = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected ${url}`);
  requests += 1;
  const method = init?.method ?? "GET";
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (method === "DELETE") { deletes += 1; return json({ id: SUB, status: "canceled" }); }
  if (url.pathname === `/v1/subscriptions/${SUB}`) {
    if (method === "POST") { posts += 1; return json(postReply); }
    return json(subscriptionReply);
  }
  if (url.pathname === `/v1/checkout/sessions/${SESSION}`) return json(sessionReply);
  if (url.pathname === "/v1/subscriptions/search") return json(searchPage);
  if (url.pathname === "/v1/subscriptions") return json(listPage);
  throw new Error(`unexpected ${method} ${url.pathname}`);
}) as typeof fetch;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A full, healthy Scale yearly reply, as Stripe sends one. */
function healthy(period: { start: number; end: number }, over: Reply = {}): Reply {
  return {
    id: SUB,
    object: "subscription",
    status: "active",
    customer: CUSTOMER,
    created: period.start,
    metadata: { store: HANDLE },
    cancel_at: null,
    cancel_at_period_end: false,
    pending_update: null,
    items: {
      object: "list",
      has_more: false,
      data: [{
        id: "si_ExactScale01",
        quantity: 1,
        current_period_start: period.start,
        current_period_end: period.end,
        price: {
          id: "price_ExactScale01",
          currency: "usd",
          unit_amount: PLAN_PRICES.scale.year,
          lookup_key: "nimbus_scale_year",
          recurring: { interval: "year", interval_count: 1 },
        },
      }],
    },
    ...over,
  };
}

/** Each reply that does not carry the plan line or the cancel fields exactly. */
function unknownShapes(period: { start: number; end: number }): [string, Reply][] {
  const base = healthy(period);
  // A synthetic reply is edited freely, one wrong field at a time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edit = (change: (reply: any) => void): Reply => { const reply = clone(base); change(reply); return reply; };
  return [
    ["id and status only (the hunt 3 proof)", { id: SUB, object: "subscription", status: "active", metadata: { store: HANDLE } }],
    ["items missing", edit((r) => { delete r.items; })],
    ["items null", edit((r) => { r.items = null; })],
    ["items.data missing", edit((r) => { delete r.items.data; })],
    ["items.data empty", edit((r) => { r.items.data = []; })],
    ["items.data with two lines", edit((r) => { r.items.data.push(clone(r.items.data[0])); })],
    ["items.data an object, not a list", edit((r) => { r.items.data = { 0: r.items.data[0], length: 1 }; })],
    ["line without a price", edit((r) => { delete r.items.data[0].price; })],
    ["price without unit_amount", edit((r) => { delete r.items.data[0].price.unit_amount; })],
    ["unit_amount as a string", edit((r) => { r.items.data[0].price.unit_amount = String(PLAN_PRICES.scale.year); })],
    ["unit_amount 0", edit((r) => { r.items.data[0].price.unit_amount = 0; })],
    ["unit_amount not whole", edit((r) => { r.items.data[0].price.unit_amount = 999.5; })],
    ["price without recurring", edit((r) => { delete r.items.data[0].price.recurring; })],
    ["line with quantity 0", edit((r) => { r.items.data[0].quantity = 0; })],
    ["line with quantity 2", edit((r) => { r.items.data[0].quantity = 2; })],
    ["line with quantity null", edit((r) => { r.items.data[0].quantity = null; })],
    ["price in another currency", edit((r) => { r.items.data[0].price.currency = "jpy"; })],
    ["price billed every 12 intervals", edit((r) => { r.items.data[0].price.recurring.interval_count = 12; })],
    ["recurring without interval", edit((r) => { r.items.data[0].price.recurring = { interval_count: 1 }; })],
    ["recurring weekly", edit((r) => { r.items.data[0].price.recurring.interval = "week"; })],
    ["named yearly price billed monthly", edit((r) => { r.items.data[0].price.recurring.interval = "month"; })],
    ["cancel_at missing", edit((r) => { delete r.cancel_at; })],
    ["cancel_at as a string", edit((r) => { r.cancel_at = "1893456000"; })],
    ["cancel_at_period_end missing", edit((r) => { delete r.cancel_at_period_end; })],
    ["cancel_at_period_end as a string", edit((r) => { r.cancel_at_period_end = "false"; })],
    ["trialing with no items", edit((r) => { r.status = "trialing"; r.trial_start = period.start; r.trial_end = period.end; delete r.items; })],
    ["past_due in grace with no cancel fields", edit((r) => { r.status = "past_due"; delete r.cancel_at; delete r.cancel_at_period_end; })],
  ];
}

async function scaleYearly(now: number, withPeriod = true): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Exact State", "Synthetic.");
  await setSubscription(OWNER, { customerId: CUSTOMER, subscriptionId: SUB, active: true, tier: "scale", cycle: "year", trialEnds: 0, period: withPeriod ? paidPeriod(now) : null });
  return (await storeForEmail(OWNER))!;
}

const snapshot = (store: Store) => [store.subscriptionActive, store.subscriptionId, store.tier, store.cycle, store.period ?? null];

async function main(): Promise<void> {
  const now = Date.now();
  const period = paidPeriod(now);

  part("Healthy controls read exactly as before");
  {
    const state = stateOf(healthy(period));
    is("healthy Scale yearly is active Scale yearly at its price, renewing, with its period",
      state.state === "active" ? [state.tier, state.cycle, state.amountCents, state.cancelsAtEnd, state.until, state.period] : state,
      ["scale", "year", PLAN_PRICES.scale.year, false, period.end, { start: period.start, end: period.end, renews: true }]);
    const stopping = stateOf(healthy(period, { cancel_at_period_end: true, cancel_at: period.end }));
    is("healthy reply set to stop reads cancelsAtEnd and its date",
      stopping.state === "active" ? [stopping.cancelsAtEnd, stopping.until, stopping.period?.renews] : stopping, [true, period.end, false]);
    const legacy = healthy(period);
    const price = (legacy.items as { data: { price: Record<string, unknown> }[] }).data[0].price;
    delete price.lookup_key;
    price.unit_amount = LEGACY_PLAN_PRICES[0].pro.month;
    price.recurring = { interval: "month", interval_count: 1 };
    const legacyState = stateOf(legacy);
    is("an unnamed price on a legacy list is still read as its plan",
      legacyState.state === "active" ? [legacyState.tier, legacyState.cycle, legacyState.amountCents] : legacyState,
      ["pro", "month", LEGACY_PLAN_PRICES[0].pro.month]);
    is("planOf of the same legacy reply is unchanged", [planOf(legacy).tier, planOf(legacy).cycle], ["pro", "month"]);
    const trial = stateOf(healthy(period, { status: "trialing", trial_start: period.start, trial_end: period.end }));
    is("a healthy trial reads as trialing until its end, with no period",
      trial.state === "active" ? [trial.trialing, trial.until, trial.period] : trial, [true, period.end, null]);
    is("a terminal status needs no plan line and stays inactive",
      stateOf({ id: SUB, object: "subscription", status: "canceled" }), { state: "inactive", reason: "canceled" });
    const stale = clone(healthy(period));
    stale.status = "past_due";
    stale.trial_end = period.start;
    is("a first payment that failed after a trial stays inactive", stateOf(stale), { state: "inactive", reason: "past_due" });

    const before = await scaleYearly(now);
    subscriptionReply = healthy(period);
    const read = await readSubscription(SUB, before);
    is("readSubscription of a healthy reply records nothing new for the same plan", await recordState(before, read), false);
    is("the store is still Scale yearly with its period", snapshot((await storeForEmail(OWNER))!), [true, SUB, "scale", "year", period]);
  }

  part("Every reply without the exact plan line or cancel fields is unknown, and nothing is written");
  for (const [name, reply] of unknownShapes(period)) {
    is(`stateOf: ${name}`, stateOf(clone(reply)), { state: "unknown" });
    const before = await scaleYearly(now);
    subscriptionReply = clone(reply);
    const state = await readSubscription(SUB, before);
    is(`readSubscription: ${name}`, state, { state: "unknown" });
    is(`recordState writes nothing: ${name}`, await recordState(before, state), false);
    is(`the store keeps Scale yearly with its period: ${name}`, snapshot((await storeForEmail(OWNER))!), [true, SUB, "scale", "year", period]);
  }

  part("The daily sync's list keeps the recorded plan on an unknown reply");
  {
    const before = await scaleYearly(now);
    listPage = { object: "list", data: [{ id: SUB, object: "subscription", status: "active", customer: { id: CUSTOMER, email: OWNER }, metadata: { store: HANDLE } }], has_more: false };
    subscriptionReply = { id: SUB, object: "subscription", status: "active", metadata: { store: HANDLE } };
    const counts = await syncSubscriptions(Date.now() + 60_000);
    is("nothing updated or adopted", [counts.updated, counts.adopted], [0, 0]);
    is("the store keeps Scale yearly with its period", snapshot((await storeForEmail(OWNER))!), snapshot(before));
    listPage = { object: "list", data: [], has_more: false };
  }

  part("refreshPeriod keeps the store on an unknown reply, and fills the period from a healthy one");
  {
    const before = await scaleYearly(now, false);
    subscriptionReply = { id: SUB, object: "subscription", status: "active", metadata: { store: HANDLE } };
    const kept = await refreshPeriod(before);
    is("unknown: the store keeps Scale yearly with no period written", [snapshot(kept), snapshot((await storeForEmail(OWNER))!)], [snapshot(before), snapshot(before)]);
    subscriptionReply = healthy(period);
    const filled = await refreshPeriod(before);
    is("healthy: the period is written and the plan kept", snapshot(filled), [true, SUB, "scale", "year", period]);
  }

  part("A cancellation reply without the plan line is refused, never read as ended");
  {
    await scaleYearly(now);
    postReply = { id: SUB, object: "subscription", status: "active", cancel_at_period_end: true };
    let threw = false;
    try { await setCancelAtPeriodEnd(SUB, true); } catch { threw = true; }
    is("setCancelAtPeriodEnd throws on an unknown reply", threw, true);
    postReply = healthy(period, { cancel_at_period_end: true, cancel_at: period.end });
    const state = await setCancelAtPeriodEnd(SUB, true);
    is("a healthy reply still confirms the stop", state.state === "active" ? [state.tier, state.cycle, state.cancelsAtEnd] : state, ["scale", "year", true]);
  }

  part("A checkout return whose subscription reply is unknown writes nothing");
  {
    const before = await scaleYearly(now);
    sessionReply = { id: SESSION, object: "checkout.session", mode: "subscription", metadata: { store: HANDLE }, customer: CUSTOMER, subscription: SUB };
    subscriptionReply = { id: SUB, object: "subscription", status: "active", metadata: { store: HANDLE } };
    let threw = false;
    try { await readStartedSubscription(before, SESSION); } catch { threw = true; }
    is("readStartedSubscription throws, so the return route writes nothing", threw, true);
    subscriptionReply = healthy(period);
    const started = await readStartedSubscription(before, SESSION);
    is("a healthy return still reads Scale yearly with its period",
      started ? [started.active, started.tier, started.cycle, started.period] : started, [true, "scale", "year", { start: period.start, end: period.end, renews: true }]);
  }

  part("A search row in good standing without typed cancel fields is neither adopted nor ended");
  for (const status of ["active", "past_due"] as const) {
    const before = await scaleYearly(now);
    const member = healthy(period, { status, customer: { id: CUSTOMER, email: OWNER } });
    delete member.cancel_at_period_end;
    delete member.cancel_at;
    searchPage = { object: "search_result", data: [member], has_more: false, next_page: null };
    listPage = { object: "list", data: [], has_more: false };
    const deletesBefore = deletes;
    let outcome: string;
    try { const found = await findStoreSubscriptions(before); outcome = found.live ? "adopted" : found.lapsed.length ? "lapsed" : "none"; }
    catch { outcome = "refused"; }
    is(`${status}: findStoreSubscriptions refuses`, outcome, "refused");
    is(`${status}: nothing was ended`, deletes, deletesBefore);
    const healthyMember = healthy(period, { status: "active", customer: { id: CUSTOMER, email: OWNER } });
    searchPage = { object: "search_result", data: [healthyMember], has_more: false, next_page: null };
    const found = await findStoreSubscriptions(before);
    is(`${status}: a healthy row is still adopted as Scale yearly`, found.live ? [found.live.tier, found.live.cycle] : found.live, ["scale", "year"]);
  }
  searchPage = { object: "search_result", data: [], has_more: false, next_page: null };

  is("only cancellation calls were posted, and nothing reached a real provider", posts, 2);
  is("requests stayed on the stand-in", requests > 0, true);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
