/**
 * One Store assistant subscription per store (R23 finding 2; synthetic, no real provider).
 *
 * Before: the add-on's start opened a new subscription checkout with no idempotency key and asked Stripe nothing about
 * an add-on subscription already paid for the store; its only guard was the local record (assistantRefusal reads
 * store.assistantPlan). When the way back from the first checkout could not read the session ("unconfirmed"), or the
 * creator paid in two tabs, a second US$69 subscription started, and the daily sync left the extra one renewing.
 *
 * Now (lib/assistant-billing.ts startAssistant): before any checkout, the customer's subscriptions are read from Stripe
 * in their exact shape (lib/stripe-list.ts). A live add-on for this store is adopted (written down, answered as
 * already on); one Stripe may still charge (incomplete, past due, unpaid, paused, trialing) opens nothing; an open
 * checkout page for this store's add-on is given again; a list not read to its end, or a row not readable, opens
 * nothing (rule 24: unknown is never "none"). The checkout itself carries a stable Idempotency-Key, so two tabs at
 * the same moment get the same page.
 *
 * Fake Stripe: a checkout paid makes an active add-on subscription; a POST with a key already used answers the same
 * session, as Stripe replays it.
 */
import { applyListedAssistant, readAssistantReturn, startAssistant, syncAssistant, type AssistantStart } from "@/lib/assistant-billing";
import { claimHandle, ensureStatsId, setAssistantPlan, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** The way a creator starts the add-on (app/api/billing/assistant/route.ts). */
const start: (store: Store, origin: string) => Promise<AssistantStart> = startAssistant;

const OWNER = "r23-assistant@example.com";
const HANDLE = "rtwothree";
const CUSTOMER = "cus_R23Assist01";
const ORIGIN = "https://marktmorgen.com";
type Sub = { id: string; status: string; customer: string; cancel_at_period_end: boolean; metadata: Record<string, string> | null; items: unknown };
type Session = { id: string; url: string; status: "open" | "complete" | "expired"; mode: string; customer: string; subscription: string | null; metadata: Record<string, string> };

let subs: Sub[] = [];
let sessions: Session[] = [];
let keys = new Map<string, string>();
let posts: { key: string | null }[] = [];
let sessionReadFails = false;
/** What the next list of the customer's subscriptions answers, when not the real list. */
let subscriptionList: ((url: URL) => Response) | null = null;
/** What the next list of the customer's open checkout pages answers, when not the real list. */
let sessionList: ((url: URL) => Response) | null = null;
let lists: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const period = paidPeriod(Date.now());
const addOn = (n: number, status: string, extra: Partial<Sub> = {}): Sub => ({
  id: `sub_R23Assist${String(n).padStart(4, "0")}`,
  status,
  customer: CUSTOMER,
  cancel_at_period_end: false,
  metadata: { addon: "assistant", assistant_for: HANDLE },
  items: { data: [{ current_period_start: period.start, current_period_end: period.end }] },
  ...extra,
});

async function freshStore(): Promise<Store> {
  redis.clear();
  subs = [];
  sessions = [];
  keys = new Map();
  posts = [];
  lists = [];
  sessionReadFails = false;
  subscriptionList = null;
  sessionList = null;
  await claimHandle(OWNER, HANDLE, "Synthetic store", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: CUSTOMER, subscriptionId: "sub_R23Plan00001", active: true, tier: "creator", trialEnds: 0, period });
  return (await storeForEmail(OWNER))!;
}

function install(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v1/, "");
    if (method === "GET" && path === "/prices") return json({ object: "list", data: [{ id: "price_R23Assist01", unit_amount: 6900, currency: "usd", recurring: { interval: "month", interval_count: 1 }, active: true }], has_more: false });
    if (method === "GET" && path === "/subscriptions") {
      lists.push("subscriptions");
      if (subscriptionList) return subscriptionList(url);
      const mine = subs.filter((s) => s.customer === url.searchParams.get("customer"));
      return json({ object: "list", data: mine, has_more: false });
    }
    if (method === "GET" && path === "/checkout/sessions") {
      lists.push("sessions");
      if (sessionList) return sessionList(url);
      const open = sessions.filter((s) => s.customer === url.searchParams.get("customer") && s.status === url.searchParams.get("status"));
      return json({ object: "list", data: open, has_more: false });
    }
    if (method === "POST" && path === "/checkout/sessions") {
      const key = new Headers(init?.headers).get("Idempotency-Key");
      posts.push({ key });
      const replay = key ? keys.get(key) : undefined;
      const known = replay ? sessions.find((s) => s.id === replay) : undefined;
      if (known) return json(known);
      const id = `cs_test_R23Assist${String(sessions.length + 1).padStart(4, "0")}`;
      const body = new URLSearchParams(String(init?.body ?? ""));
      const made: Session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", mode: "subscription", customer: body.get("customer") ?? "", subscription: null, metadata: { addon: body.get("metadata[addon]") ?? "", assistant_for: body.get("metadata[assistant_for]") ?? "" } };
      sessions.push(made);
      if (key) keys.set(key, id);
      return json(made);
    }
    if (method === "GET" && path.startsWith("/checkout/sessions/")) {
      if (sessionReadFails) return json({ error: { type: "api_error", message: "down" } }, 500);
      const id = decodeURIComponent(path.slice("/checkout/sessions/".length));
      const s = sessions.find((one) => one.id === id);
      return s ? json(s) : json({ error: { type: "invalid_request_error", message: "No such session" } }, 404);
    }
    const one = path.match(/^\/subscriptions\/([^/]+)$/);
    if (one) {
      const sub = subs.find((s) => s.id === one[1]);
      if (!sub) return json({ error: { type: "invalid_request_error", message: "No such subscription" } }, 404);
      if (method === "POST") sub.cancel_at_period_end = new URLSearchParams(String(init?.body ?? "")).get("cancel_at_period_end") === "true";
      if (method === "DELETE") sub.status = "canceled";
      return json(sub);
    }
    if (method === "GET" && path === "/invoices") return json({ object: "list", data: [{ id: `in_${url.searchParams.get("subscription")}`, charge: { id: "ch_R23", disputed: invoicesDisputed } }], has_more: false });
    throw new Error(`unexpected ${method} ${path}`);
  }) as typeof fetch;
}
let invoicesDisputed = false;

/** The creator pays on Stripe's page: an active add-on subscription exists from then on. */
function pay(checkoutUrl: string): string {
  const session = sessions.find((s) => s.url === checkoutUrl)!;
  const sub = addOn(subs.length + 1, "active");
  subs.push(sub);
  session.subscription = sub.id;
  session.status = "complete";
  return session.id;
}

/** What a start that must not open a checkout gives: a word for the test, never a URL. */
async function outcome(store: Store): Promise<string> {
  try {
    const started = await start(store, ORIGIN);
    if ("checkout" in started) return `checkout ${started.checkout}`;
    if ("waiting" in started) return "waiting";
    return `already ${started.already.assistantPlan?.subscriptionId} active=${started.already.assistantPlan?.active} disputed=${Boolean(started.already.assistantPlan?.disputedAt)}`;
  } catch {
    return "refused";
  }
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_r23_assistant_only";
  install();
  const now = Date.now();

  part("Paid, then the way back cannot read the session (unconfirmed): the next start adopts it");
  let store = await freshStore();
  const first = await start(store, ORIGIN);
  is("the first start opens a checkout", "checkout" in first, true);
  const firstSession = pay((first as { checkout: string }).checkout);
  sessionReadFails = true;
  let back = "";
  try {
    await readAssistantReturn(store, firstSession);
    back = "read";
  } catch {
    back = "unconfirmed";
  }
  is("the way back says unconfirmed (as the route does on a throw)", back, "unconfirmed");
  sessionReadFails = false;
  store = (await storeForEmail(OWNER))!;
  is("nothing was written on the way back", store.assistantPlan ?? null, null);
  const second = await outcome(store);
  is("the second start adopts the live add-on and opens no checkout", second, "already sub_R23Assist0001 active=true disputed=false");
  is("one checkout was ever created", posts.length, 1);
  // Had a second page opened, the creator, told to try again, would pay it too.
  if (second.startsWith("checkout ")) {
    const plan = await readAssistantReturn(store, pay(second.slice("checkout ".length)));
    if (plan) await setAssistantPlan(OWNER, plan);
  }
  store = (await storeForEmail(OWNER))!;
  is("the live add-on is written down for the store", [store.assistantPlan?.subscriptionId, store.assistantPlan?.active], ["sub_R23Assist0001", true]);

  part("Then the daily sync and a lapsed plan: one subscription only, and it stops");
  for (const sub of subs) await applyListedAssistant({ ...sub });
  is("at most one add-on subscription renews for one store", subs.filter((s) => s.status === "active" && !s.cancel_at_period_end).length, 1);
  await setSubscription(OWNER, { customerId: CUSTOMER, subscriptionId: "sub_R23Plan00001", active: false, tier: "creator", trialEnds: 0, period });
  await syncAssistant((await storeForEmail(OWNER))!, undefined, now / 1000);
  for (const sub of subs) await applyListedAssistant({ ...sub });
  is("no add-on subscription renews after the plan lapsed", subs.filter((s) => s.status === "active" && !s.cancel_at_period_end).map((s) => s.id), []);

  part("Two tabs: an open page for this store's add-on is given again, never a second one");
  store = await freshStore();
  const tabOne = await outcome(store);
  const tabTwo = await outcome(store);
  is("the second tab gets the first tab's page", [tabOne, tabTwo], ["checkout https://checkout.stripe.com/c/pay/cs_test_R23Assist0001", "checkout https://checkout.stripe.com/c/pay/cs_test_R23Assist0001"]);
  is("one checkout created for both tabs", posts.length, 1);

  part("Two tabs at the same moment: both POSTs carry the same Idempotency-Key, so Stripe gives one page");
  store = await freshStore();
  const both = await Promise.all([outcome(store), outcome(store)]);
  is("both tabs get the same page", both[0] === both[1] && both[0].startsWith("checkout "), true);
  is("every checkout POST carries a key, and the same one", [posts.length > 0, posts.every((p) => typeof p.key === "string" && p.key.length > 0), new Set(posts.map((p) => p.key)).size], [true, true, 1]);
  is("one session exists at Stripe", sessions.length, 1);

  part("One Stripe may still charge for this store: nothing is opened beside it");
  for (const status of ["incomplete", "past_due", "unpaid", "paused", "trialing"]) {
    store = await freshStore();
    subs.push(addOn(1, status));
    is(`an add-on ${status}: no checkout`, [await outcome(store), posts.length], ["waiting", 0]);
  }

  part("A disputed live add-on found at Stripe: adopted, ended, and not sold again");
  store = await freshStore();
  subs.push(addOn(1, "active"));
  invoicesDisputed = true;
  is("the start answers it disputed and opens nothing", [await outcome(store), posts.length], ["already sub_R23Assist0001 active=false disputed=true", 0]);
  is("the disputed add-on is ended at Stripe", subs[0].status, "canceled");
  invoicesDisputed = false;

  part("Unknown is never none: the subscription list in any other shape opens nothing");
  const unknownSubs: [string, (url: URL) => Response][] = [
    ["a server error", () => json({ error: { type: "api_error", message: "down" } }, 500)],
    ["a body of null", () => json(null)],
    ["data not a list", () => json({ object: "list", data: null, has_more: false })],
    ["has_more missing", () => json({ object: "list", data: [] })],
    ["a row with an unknown status", () => json({ object: "list", data: [{ ...addOn(1, "active"), status: "mystery" }], has_more: false })],
    ["a row with no id", () => json({ object: "list", data: [{ status: "canceled", metadata: null }], has_more: false })],
    ["a row whose metadata is a string", () => json({ object: "list", data: [{ ...addOn(1, "canceled"), metadata: "assistant" }], has_more: false })],
    ["this store's add-on on another customer", () => json({ object: "list", data: [addOn(1, "canceled", { customer: "cus_OtherOne01" })], has_more: false })],
    ["more pages with no last id", () => json({ object: "list", data: [{ status: "canceled" }], has_more: true })],
    ["more pages than are read", (url) => json({ object: "list", data: [addOn(Number(url.searchParams.get("starting_after")?.slice(-4) ?? 0) + 1, "canceled", { metadata: null })], has_more: true })],
  ];
  for (const [what, reply] of unknownSubs) {
    store = await freshStore();
    subscriptionList = reply;
    is(`subscriptions: ${what}`, [await outcome(store), posts.length], ["refused", 0]);
  }

  part("Unknown is never none: the list of open pages in any other shape opens nothing");
  const unknownSessions: [string, (url: URL) => Response][] = [
    ["a server error", () => json({ error: { type: "api_error", message: "down" } }, 500)],
    ["a body of null", () => json(null)],
    ["has_more not true or false", () => json({ object: "list", data: [], has_more: "no" })],
    ["a row with an unknown mode", () => json({ object: "list", data: [{ id: "cs_test_R23Other0001", status: "open", mode: 7, metadata: null, url: null, customer: CUSTOMER }], has_more: false })],
    ["this store's open page with no URL", () => json({ object: "list", data: [{ id: "cs_test_R23Other0001", status: "open", mode: "subscription", customer: CUSTOMER, metadata: { addon: "assistant", assistant_for: HANDLE }, url: null }], has_more: false })],
    ["this store's page not open", () => json({ object: "list", data: [{ id: "cs_test_R23Other0001", status: "complete", mode: "subscription", customer: CUSTOMER, metadata: { addon: "assistant", assistant_for: HANDLE }, url: "https://checkout.stripe.com/c/pay/cs_test_R23Other0001" }], has_more: false })],
    ["more pages with no last id", () => json({ object: "list", data: [{ status: "open" }], has_more: true })],
  ];
  for (const [what, reply] of unknownSessions) {
    store = await freshStore();
    sessionList = reply;
    is(`open pages: ${what}`, [await outcome(store), posts.length], ["refused", 0]);
  }

  part("Controls: what is not this store's live add-on still lets the checkout open, once, with a key");
  store = await freshStore();
  subs.push(
    { ...addOn(1, "active"), metadata: { store: HANDLE, tier: "creator" } },
    addOn(2, "active", { metadata: { addon: "assistant", assistant_for: "anotherstore" } }),
    addOn(3, "canceled"),
    addOn(4, "incomplete_expired"),
    addOn(5, "active", { metadata: null }),
  );
  sessions.push({ id: "cs_test_R23Plan00001", url: "https://checkout.stripe.com/c/pay/cs_test_R23Plan00001", status: "open", mode: "subscription", customer: CUSTOMER, subscription: null, metadata: { store: HANDLE } } as unknown as Session);
  const opened = await outcome(store);
  is("the plan's subscription, another store's add-on and ended ones open a new checkout", opened.startsWith("checkout https://checkout.stripe.com/c/pay/cs_test_R23Assist"), true);
  is("one POST, with a key", [posts.length, typeof posts[0]?.key], [1, "string"]);
  is("the subscriptions were read before the open pages, both before the POST", lists, ["subscriptions", "sessions"]);
  store = (await storeForEmail(OWNER))!;
  is("nothing is written down for the store", store.assistantPlan ?? null, null);

  part("Control: a store whose record already says on is refused locally, without asking Stripe");
  store = await freshStore();
  await setAssistantPlan(OWNER, { subscriptionId: "sub_R23Assist0009", active: true, period, cancelsAtEnd: false, disputedAt: "" });
  store = (await storeForEmail(OWNER))!;
  is("refused, with no list read and no POST", [await outcome(store), lists.length, posts.length], ["refused", 0, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
