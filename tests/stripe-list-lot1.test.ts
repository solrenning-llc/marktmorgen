/**
 * CX-123 rules 24 and 30, lists from Stripe, lot 1 (money; C4-20261106-0105-C5-13):
 * a list read in another shape, or read only in part, is never taken for an
 * empty one. A "yes" may come from any readable row; a "no", a "none" or a
 * "zero" only from a list read to its end with every row readable
 * (lib/stripe-list.ts). Each point, against a stand-in for Stripe:
 *
 *   - plan disputes (lib/plan-disputes.ts): a page in another shape, or a row
 *     not readable, never marks the run complete;
 *   - plan refunds (lib/plan-refund-write.ts): a charge's refunds read in
 *     another shape, or with a row not readable, make no refund;
 *   - the Store assistant add-on (lib/assistant-billing.ts): whether a payment
 *     was disputed is not known from a page in another shape, so nothing is
 *     written on it this run; a dispute on a readable row still ends it;
 *   - an offer after paying (lib/upsell.ts): its charge is "not there" only
 *     when the customer's payments were read whole; one on a later page is found;
 *   - running memberships (lib/payment-methods.ts): never "none" from a page
 *     in another shape or a row not readable.
 */
import { syncPlanDisputes } from "@/lib/plan-disputes";
import { refundPlanPayment } from "@/lib/plan-refund-write";
import { syncAssistant } from "@/lib/assistant-billing";
import { OFFER_PAGES_IN_JOB, OFFER_PAGES_ON_PAGE, findOfferCharge, readUpsell, settlePendingOffers, settleUpsells } from "@/lib/upsell";
import { runningSubscriptions } from "@/lib/payment-methods";
import { STRIPE_LIST_VERSION, StripeListUnreadable, readStripePage } from "@/lib/stripe-list";
import { STRIPE_VERSION } from "@/lib/stripe-connect";
import { claimHandle, ensureStatsId, setAssistantPlan, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_stripe_list_lot1_only";

type Handler = (method: string, path: string, query: URLSearchParams, init?: RequestInit) => Response | null;
let handler: Handler = () => null;
const sent: { method: string; path: string; version: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  sent.push({ method, path, version: new Headers(init?.headers).get("stripe-version") });
  return handler(method, path, url.searchParams, init) ?? Response.json({ error: { message: `no stand-in for ${method} ${path}` } }, { status: 404 });
}) as typeof fetch;
const list = (data: unknown[], hasMore = false) => Response.json({ object: "list", data, has_more: hasMore });
/** Pages Stripe never gives: in another shape, as a proxy or a cache in the way could hand back. */
const GARBLED: [string, unknown][] = [
  ["no data", { object: "list", has_more: false }],
  ["data not a list", { object: "list", data: {}, has_more: false }],
  ["has_more missing", { object: "list", data: [] }],
  ["has_more as text", { object: "list", data: [], has_more: "false" }],
  ["not an object", []],
];

async function reader(): Promise<void> {
  part("The reader: a page in its exact shape, each row by its own fields");
  for (const [label, page] of GARBLED) {
    let thrown = "";
    try {
      readStripePage(page);
    } catch (error) {
      thrown = error instanceof StripeListUnreadable ? "unreadable" : String(error);
    }
    is(`${label}: not a page`, thrown, "unreadable");
  }
  const page = readStripePage({ data: [{ id: "sub_a1" }, "sub_b2", { id: 7 }, { id: "sub_c3", status: 1 }, { id: "sub_d4", status: "active" }], has_more: true }, (row) => typeof row.status === "string" || !("status" in row));
  is("readable rows kept, the others counted, never dropped silently", [page.rows.map((r) => r.id), page.unreadable, page.hasMore, page.lastId], [["sub_a1", "sub_d4"], 3, true, "sub_d4"]);
  const inherited = Object.create({ id: "sub_proto" });
  const getter = {};
  Object.defineProperty(getter, "id", { get: () => "sub_getter", enumerable: true });
  is("an inherited id or a getter is not readable", readStripePage({ data: [inherited, getter], has_more: false }).unreadable, 2);
  is("the next page starts only from a readable last row", readStripePage({ data: [{ id: "sub_a1" }, "x"], has_more: true }).lastId, null);
  is("the lot pins the version STRIPE_VERSION names", STRIPE_LIST_VERSION, STRIPE_VERSION);
}

async function disputes(): Promise<void> {
  part("plan-disputes.ts: a page in another shape or a row not readable never completes the run");
  for (const [label, page] of GARBLED) {
    redis.clear();
    handler = (method, path) => (method === "GET" && path === "/disputes" ? Response.json(page) : null);
    const counts = await syncPlanDisputes(Date.now() + 30_000);
    is(`disputes answered ${label}: not complete, a failure counted`, [counts.complete, counts.failed > 0], [false, true]);
  }
  redis.clear();
  handler = (method, path) => (method === "GET" && path === "/disputes" ? list(["dp_garbled"]) : null);
  const counts = await syncPlanDisputes(Date.now() + 30_000);
  is("a row not readable: counted as failed, not complete", [counts.complete, counts.failed], [false, 1]);
  redis.clear();
  handler = (method, path) => (method === "GET" && path === "/disputes" ? list([]) : null);
  is("a whole, readable empty list completes", (await syncPlanDisputes(Date.now() + 30_000)).complete, true);
}

async function planRefunds(): Promise<void> {
  part("plan-refund-write.ts: refunds read in another shape, or with a row not readable, make no refund");
  const DAY = 86_400;
  const NOW = Math.floor(Date.now() / 1000);
  let shop = 0;
  const made: string[] = [];
  const shopWith = async (refundsPage: unknown) => {
    shop += 1;
    const handle = `lotone${shop}`;
    const email = `${handle}@example.com`;
    const customer = `cus_${handle}01`;
    const sub = `sub_${handle}01`;
    const charge = `ch_${handle}x1`;
    await claimHandle(email, handle, `Lot ${shop}`, "");
    await setSubscription(email, { customerId: customer, subscriptionId: sub, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
    const at = NOW - 3 * DAY;
    const invoice = { id: `in_${handle}x1`, subscription: sub, status: "paid", created: at, total: 6_900, tax: null, billing_reason: "subscription_create", charge, status_transitions: { paid_at: at }, lines: { data: [{ type: "subscription", period: { start: at }, price: { unit_amount: 6_900, currency: "usd", recurring: { interval: "month" } } }] } };
    const chargeRow = { id: charge, customer, invoice: invoice.id, payment_intent: `pi_${handle}x1`, status: "succeeded", paid: true, currency: "usd", created: at, amount_captured: 6_900, amount_refunded: 0, disputed: false, payment_method_details: { card: { fingerprint: `fp${handle}` } }, balance_transaction: { fee: 230, currency: "usd" } };
    handler = (method, path, q) => {
      if (method === "POST" && path === "/refunds") {
        made.push(handle);
        return Response.json({ id: `re_${handle}made`, object: "refund", amount: 6_900, currency: "usd", status: "succeeded" });
      }
      if (method !== "GET") return null;
      if (path === `/subscriptions/${sub}`) return Response.json({ id: sub, customer: { id: customer, email, balance: 0 }, metadata: { store: handle } });
      if (path === "/invoices") return list(q.get("subscription") === sub ? [invoice] : []);
      if (path === "/charges") return list(q.get("customer") === customer ? [chargeRow] : []);
      if (path === `/charges/${charge}`) return Response.json(chargeRow);
      if (path === "/charges/search" || path === "/customers/search") return Response.json({ object: "search_result", data: [], has_more: false });
      if (path === "/disputes") return list([]);
      if (path === "/refunds") return Response.json(refundsPage);
      return null;
    };
    return (await storeForEmail(email))!;
  };
  for (const [label, page] of [...GARBLED.filter(([l]) => l !== "has_more missing" && l !== "has_more as text"), ["a row not readable", { object: "list", data: ["re_garbled"], has_more: false }] as [string, unknown]]) {
    made.length = 0;
    const store = await shopWith(page);
    const result = await refundPlanPayment(store, NOW);
    is(`refunds answered ${label}: nothing made`, [result.ok, made.length], [false, 0]);
  }
  // Codex CX1 on #2759: a row is a refund only with a refund's own id; any other id is not readable, so no refund.
  for (const [label, id] of [["a subscription's id", "sub_CX1Wrong0001"], ["underscores only", "___"]]) {
    made.length = 0;
    const store = await shopWith({ object: "list", data: [{ id, object: "refund", status: "failed", amount: 6_900 }], has_more: false });
    const result = await refundPlanPayment(store, NOW);
    is(`a refund row with ${label} for id: not readable, nothing made`, [result.ok, made.length], [false, 0]);
  }
  made.length = 0;
  const fine = await shopWith({ object: "list", data: [], has_more: false });
  const fineResult = await refundPlanPayment(fine, NOW);
  is("refunds read whole and readable: the refund is made once", [fineResult.ok, made.length], [true, 1]);
}

async function assistant(): Promise<void> {
  part("assistant-billing.ts: a dispute not known from the page writes nothing this run; one on a readable row ends the add-on");
  redis.clear();
  const owner = "lot1-assistant@example.com";
  await claimHandle(owner, "lotoneassist", "Lot assistant", "");
  await ensureStatsId(owner);
  // A plan no longer paid: on "not disputed", the add-on is set to stop at the end of its month.
  await setSubscription(owner, { customerId: "cus_LotOneAssist1", subscriptionId: "sub_LotOnePlan1", active: false, tier: "creator", trialEnds: 0, period: paidPeriod(Date.now() - 60 * 86_400_000) });
  const period = paidPeriod(Date.now());
  let invoices: unknown = { object: "list", data: [], has_more: false };
  const writes: string[] = [];
  handler = (method, path) => {
    if (path === "/subscriptions/sub_LotOneAssist1") {
      if (method === "GET") return Response.json({ id: "sub_LotOneAssist1", status: "active", cancel_at_period_end: false, items: { object: "list", data: [{ id: "si_LotOne1", current_period_start: period.start, current_period_end: period.end }], has_more: false } });
      writes.push(method);
      return Response.json({ id: "sub_LotOneAssist1", status: method === "DELETE" ? "canceled" : "active", cancel_at_period_end: true });
    }
    if (method === "GET" && path === "/invoices") return Response.json(invoices);
    return null;
  };
  const plan = { subscriptionId: "sub_LotOneAssist1", active: true, period, cancelsAtEnd: false, disputedAt: "" };
  for (const [label, page] of [...GARBLED, ["a row not readable beside a readable one", { object: "list", data: [{ id: "in_ok1", charge: { id: "ch_ok1", disputed: false } }, { id: "in_bad1", charge: "ch_unexpanded" }], has_more: false }] as [string, unknown]]) {
    await setAssistantPlan(owner, plan);
    invoices = page;
    writes.length = 0;
    await syncAssistant((await storeForEmail(owner))!);
    is(`invoices answered ${label}: nothing written this run`, writes, []);
  }
  await setAssistantPlan(owner, plan);
  invoices = { object: "list", data: [{ id: "in_bad2", charge: "ch_unexpanded" }, { id: "in_disp1", charge: { id: "ch_disp1", disputed: true } }], has_more: true };
  writes.length = 0;
  const after = await syncAssistant((await storeForEmail(owner))!);
  is("a dispute on a readable row ends the add-on at once, whatever the other rows", [writes, Boolean(after.assistantPlan?.disputedAt)], [["DELETE"], true]);
}

async function offers(): Promise<void> {
  part("upsell.ts: an offer's charge is 'not there' only from the customer's payments read whole");
  const store = { handle: "lotoneoffer", previousHandles: [], stripeAccountId: "acct_1LotOneOffer01" } as unknown as Store;
  const ours = { id: "pi_LotOneOurs01", metadata: { kind: "upsell", parent: "cs_test_lotoneparent01", step: "" } };
  const other = (n: number) => ({ id: `pi_LotOneOther${String(n).padStart(3, "0")}`, metadata: {} });
  let pages: unknown[] = [];
  handler = (method, path, q) => {
    if (method !== "GET" || path !== "/payment_intents") return null;
    const after = q.get("starting_after");
    const index = after ? pages.findIndex((p) => ((p as { data: { id: string }[] }).data ?? []).some((row) => row?.id === after)) + 1 : 0;
    return Response.json(pages[Math.min(index, pages.length - 1)]);
  };
  for (const [label, page] of GARBLED) {
    pages = [page];
    let outcome = "";
    try {
      outcome = (await findOfferCharge(store, "cs_test_lotoneparent01", "", "cus_LotOneOffer1")) === null ? "not there" : "found";
    } catch {
      outcome = "unknown";
    }
    is(`payments answered ${label}: not known, never "not there"`, outcome, "unknown");
  }
  pages = [{ object: "list", data: [other(1), "pi_garbled"], has_more: false }];
  let outcome = "";
  try {
    outcome = (await findOfferCharge(store, "cs_test_lotoneparent01", "", "cus_LotOneOffer1")) === null ? "not there" : "found";
  } catch {
    outcome = "unknown";
  }
  is("a row not readable: not known", outcome, "unknown");
  pages = [{ object: "list", data: Array.from({ length: 3 }, (_, i) => other(i)), has_more: true }, { object: "list", data: [ours], has_more: false }];
  is("its charge on a later page is found", (await findOfferCharge(store, "cs_test_lotoneparent01", "", "cus_LotOneOffer1"))?.id, ours.id);
  pages = [{ object: "list", data: [other(1)], has_more: false }];
  is("read whole and readable, not among them: not there", await findOfferCharge(store, "cs_test_lotoneparent01", "", "cus_LotOneOffer1"), null);
  is("each read pinned to the lot's version", sent.filter((s) => s.path === "/payment_intents").every((s) => s.version === STRIPE_LIST_VERSION), true);

  // Claude 4's cost note on #2759: one page a waiting offer on the buyer's own page, up to five in the job.
  is("one page on the buyer's page, five in the job", [OFFER_PAGES_ON_PAGE, OFFER_PAGES_IN_JOB], [1, 5]);
  const many = Array.from({ length: 8 }, (_, n) => ({ object: "list", data: [other(n)], has_more: n < 7 }));
  const reads = () => sent.filter((s) => s.method === "GET" && s.path === "/payment_intents").length;
  pages = many;
  let before = reads();
  let thrown = false;
  try {
    await findOfferCharge(store, "cs_test_lotoneparent01", "", "cus_LotOneOffer1", OFFER_PAGES_ON_PAGE);
  } catch (error) {
    thrown = error instanceof StripeListUnreadable;
  }
  is("one page read and more to come: not known, never 'not there'", [reads() - before, thrown], [1, true]);
  const waiting = { state: "pending", product: "lotoneupsell", customer: "cus_LotOneOffer1", at: Date.now() - 60 * 60 * 1000 };
  await redis.pipeline([["SET", "nl:upsell:cs_test_lotoneparent02", JSON.stringify(waiting)]]);
  before = reads();
  await settleUpsells(store, "cs_test_lotoneparent02");
  is("the buyer's page reads one page for a waiting offer", reads() - before, OFFER_PAGES_ON_PAGE);
  is("and the offer an hour old stays waiting, never closed as lost", (await readUpsell("cs_test_lotoneparent02"))?.state, "pending");
  await redis.pipeline([["ZADD", "nl:upsell:pending", 0, "lotoneoffer|cs_test_lotoneparent02|"]]);
  before = reads();
  await settlePendingOffers(async () => store, Date.now() + 60_000);
  is("the five-minute job reads up to five pages for it", reads() - before, OFFER_PAGES_IN_JOB);
  is("and it still waits, the list not read to its end", (await readUpsell("cs_test_lotoneparent02"))?.state, "pending");
  pages = [many[0], { object: "list", data: [ours], has_more: false }];
  is("in the job's pages, its charge on page two is found", (await findOfferCharge(store, "cs_test_lotoneparent01", "", "cus_LotOneOffer1", OFFER_PAGES_IN_JOB))?.id, ours.id);
}

async function memberships(): Promise<void> {
  part("payment-methods.ts: never 'none running' from a page in another shape or a row not readable");
  const store = { handle: "lotonemembers", previousHandles: [], stripeAccountId: "acct_1LotOneMembers1" } as unknown as Store;
  let page: unknown = null;
  handler = (method, path) => (method === "GET" && path === "/subscriptions" ? Response.json(page) : null);
  for (const [label, garbled] of GARBLED) {
    page = garbled;
    is(`subscriptions answered ${label}: not known`, await runningSubscriptions(store), null);
  }
  page = { object: "list", data: ["sub_garbled"], has_more: false };
  is("a row not readable and none of ours readable: not known", await runningSubscriptions(store), null);
  page = { object: "list", data: ["sub_garbled", { id: "sub_LotOneMine1", metadata: { store: "lotonemembers" } }], has_more: false };
  is("one of ours readable beside a row not readable: at least that one (a yes stands)", ((await runningSubscriptions(store)) ?? 0) >= 1, true);
  // Codex CX1 on #2759: whose a subscription is cannot be read from a store that is not text, so it is never "none".
  for (const [label, soldBy] of [["false", false], ["7", 7], ["an object", { handle: "lotonemembers" }]] as [string, unknown][]) {
    page = { object: "list", data: [{ id: "sub_LotOneOdd01", metadata: { store: soldBy } }], has_more: false };
    is(`a row whose store is ${label}: not known`, await runningSubscriptions(store), null);
  }
  page = { object: "list", data: [{ id: "sub_LotOneElse1", metadata: { store: "elsewhere" } }], has_more: false };
  is("read whole and readable, none ours: none", await runningSubscriptions(store), 0);
  is("each read pinned to the lot's version", sent.filter((s) => s.path === "/subscriptions").every((s) => s.version === STRIPE_LIST_VERSION), true);
}

async function main(): Promise<void> {
  await reader();
  await disputes();
  await planRefunds();
  await assistant();
  await offers();
  await memberships();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
