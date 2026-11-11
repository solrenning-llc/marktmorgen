/**
 * Audit R18 (synthetic): the way back from a plan checkout
 * (app/api/billing/return/route.ts) wrote whatever a checkout session named,
 * even when an old session named a subscription that ended long ago and the
 * store runs a newer one:
 *
 *   1. checkout cs_old makes sub_Old (legacy, unfunded); later it is canceled;
 *   2. the creator subscribes again: sub_New, active, written on the store;
 *   3. the browser opens /api/billing/return?session_id=cs_old again
 *      (history, the back button, an old tab).
 *
 * The store became sub_Old, inactive, with a plan-ended date, so its checkout
 * closed until the daily job adopted sub_New again. The route now follows the
 * daily job's rule (lib/billing-sync.ts, applyListed): the store's own
 * subscription, or the first one, is brought in line; another one is written
 * only when it is paying and the store has nothing paying written down; and
 * the way back never ends a paying store on a reading it cannot trust (a
 * subscription that could not be read comes back inactive). The route runs
 * whole, with a real studio session; Stripe is a stand-in.
 *
 * Two ways back can overlap (an old tab and the new checkout, or the daily
 * job): the store may change after the route read it and before it writes.
 * The write is held to the store the decision was made on, so a stale one
 * never lands, and the old tab is told what the store holds now.
 */
import { NextRequest } from "next/server";
import { GET as back } from "@/app/api/billing/return/route";
import { isPaidUp } from "@/lib/billing";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_r18_synthetic_only";
delete process.env.STRIPE_CONNECT_API_BASE;

const now = Math.floor(Date.now() / 1000);
type Reply = Record<string, unknown>;
const sessions = new Map<string, Reply>();
const subscriptions = new Map<string, Reply>();
const unreadable = new Set<string>();
/** Runs once while Stripe is being asked for that subscription: another writer's turn. */
const meanwhile = new Map<string, () => Promise<void>>();
let posts = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  if (method !== "GET") posts += 1;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const session = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_\w+)$/);
  if (session) return sessions.has(session[1]) ? json(sessions.get(session[1])) : json({ error: { message: "No such checkout session" } }, 404);
  const sub = url.pathname.match(/^\/v1\/subscriptions\/(sub_\w+)$/);
  if (sub && method === "GET") {
    if (unreadable.has(sub[1])) return json({ error: { message: "synthetic outage" } }, 500);
    const turn = meanwhile.get(sub[1]);
    if (turn) { meanwhile.delete(sub[1]); await turn(); }
    return subscriptions.has(sub[1]) ? json(subscriptions.get(sub[1])) : json({ error: { message: "No such subscription" } }, 404);
  }
  return json({ error: { message: `no stand-in for ${method} ${url.pathname}` } }, 404);
}) as typeof fetch;

/** A legacy (unfunded) Marktmorgen plan subscription, as Stripe sends one in full. */
function subscription(id: string, customer: string, handle: string, status: "active" | "canceled"): Reply {
  const live = status === "active";
  const start = live ? now - 5 * 86_400 : now - 90 * 86_400;
  const end = live ? now + 25 * 86_400 : now - 60 * 86_400;
  return {
    id, object: "subscription", status, customer, created: start,
    ...(live ? {} : { ended_at: end, canceled_at: end }),
    metadata: { store: handle }, cancel_at: null, cancel_at_period_end: false, pending_update: null,
    items: { object: "list", has_more: false, data: [{
      id: `si_${id.slice(4)}`, quantity: 1, current_period_start: start, current_period_end: end,
      price: { id: "price_R18Creator01", currency: "usd", unit_amount: 6900, lookup_key: "nimbus_creator_month", recurring: { interval: "month", interval_count: 1 } },
    }] },
  };
}

function checkout(id: string, customer: string, subscriptionId: string, handle: string) {
  sessions.set(id, { id, object: "checkout.session", mode: "subscription", status: "complete", customer, subscription: subscriptionId, metadata: { store: handle } });
}

const billingOf = (response: Response) => new URL(response.headers.get("Location") ?? "https://x.test/").searchParams.get("billing");
const plan = (store: Store) => [store.subscriptionId, store.subscriptionActive, isPaidUp(store), store.planEndedAt];

async function shop(n: number) {
  const owner = `r18-replay-${n}@example.com`;
  const handle = `r18replay${n}`;
  await claimHandle(owner, handle, `R18 replay shop ${n}`, "");
  await ensureStatsId(owner);
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const come = async (session: string) => back(new NextRequest(`https://marktmorgen.test/api/billing/return?session_id=${session}`, { headers: { cookie } }));
  const read = async () => (await storeForEmail(owner))!;
  return { owner, handle, come, read, customer: `cus_R18Shop${n}000` };
}

async function main() {
  redis.clear();

  part("The defect: an old session's canceled subscription, after the creator subscribed again");
  {
    const s = await shop(1);
    const OLD = "sub_R18OldPlan01", NEW = "sub_R18NewPlan01";
    subscriptions.set(OLD, subscription(OLD, s.customer, s.handle, "canceled"));
    subscriptions.set(NEW, subscription(NEW, s.customer, s.handle, "active"));
    checkout("cs_test_R18OldSession0001", s.customer, OLD, s.handle);
    await setSubscription(s.owner, { customerId: s.customer, subscriptionId: NEW, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
    is("before: the store runs sub_New, paid up, no plan-ended date", plan(await s.read()), [NEW, true, true, ""]);
    const answer = await s.come("cs_test_R18OldSession0001");
    is("the old session is told the store already pays", billingOf(answer), "already");
    is("after: the store still runs sub_New, paid up, no plan-ended date", plan(await s.read()), [NEW, true, true, ""]);
  }

  part("The same old session when the newer subscription is not paying either");
  {
    const s = await shop(2);
    const OLD = "sub_R18OldPlan02", NEW = "sub_R18NewPlan02";
    subscriptions.set(OLD, subscription(OLD, s.customer, s.handle, "canceled"));
    checkout("cs_test_R18OldSession0002", s.customer, OLD, s.handle);
    await setSubscription(s.owner, { customerId: s.customer, subscriptionId: NEW, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
    await setSubscription(s.owner, { active: false });
    const before = await s.read();
    const answer = await s.come("cs_test_R18OldSession0002");
    is("nothing written: the store keeps naming sub_New and its own plan-ended date", plan(await s.read()), [NEW, false, false, before.planEndedAt]);
    is("told it is not confirmed, never that a plan started", billingOf(answer), "unconfirmed");
  }

  part("A paying store whose own subscription could not be read on the way back");
  {
    const s = await shop(3);
    const SUB = "sub_R18OwnPlan03";
    subscriptions.set(SUB, subscription(SUB, s.customer, s.handle, "active"));
    checkout("cs_test_R18OwnSession0003", s.customer, SUB, s.handle);
    await setSubscription(s.owner, { customerId: s.customer, subscriptionId: SUB, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
    unreadable.add(SUB);
    const answer = await s.come("cs_test_R18OwnSession0003");
    unreadable.delete(SUB);
    is("an unknown reading never ends the plan", plan(await s.read()), [SUB, true, true, ""]);
    is("told to look again later, never that it ended", billingOf(answer), "unconfirmed");
  }

  part("A second subscription in good standing beside the one the store runs");
  {
    const s = await shop(4);
    const RUNS = "sub_R18RunsPlan04", OTHER = "sub_R18OtherPln04";
    subscriptions.set(OTHER, subscription(OTHER, s.customer, s.handle, "active"));
    checkout("cs_test_R18OtherSessn0004", s.customer, OTHER, s.handle);
    await setSubscription(s.owner, { customerId: s.customer, subscriptionId: RUNS, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
    const answer = await s.come("cs_test_R18OtherSessn0004");
    is("left for a person, as the daily job does: the store keeps the one it runs", [plan(await s.read()), billingOf(answer)], [[RUNS, true, true, ""], "already"]);
  }

  part("Controls: the healthy ways back are unchanged");
  {
    const s = await shop(5);
    const FIRST = "sub_R18FirstPln05";
    subscriptions.set(FIRST, subscription(FIRST, s.customer, s.handle, "active"));
    checkout("cs_test_R18FirstSessn0005", s.customer, FIRST, s.handle);
    const answer = await s.come("cs_test_R18FirstSessn0005");
    is("a first subscription is written and the store is paid up", [plan(await s.read()), billingOf(answer)], [[FIRST, true, true, ""], "on"]);
    const again = await s.come("cs_test_R18FirstSessn0005");
    is("coming back through the same session again changes nothing", [plan(await s.read()), billingOf(again)], [[FIRST, true, true, ""], "on"]);
  }
  {
    const s = await shop(6);
    const OLD = "sub_R18OldPlan06", NEW = "sub_R18NewPlan06";
    subscriptions.set(NEW, subscription(NEW, s.customer, s.handle, "active"));
    checkout("cs_test_R18NewSession0006", s.customer, NEW, s.handle);
    await setSubscription(s.owner, { customerId: s.customer, subscriptionId: OLD, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
    await setSubscription(s.owner, { active: false });
    const answer = await s.come("cs_test_R18NewSession0006");
    is("subscribing again after a plan ended adopts the new paying one", [plan(await s.read()), billingOf(answer)], [[NEW, true, true, ""], "on"]);
  }
  {
    const s = await shop(7);
    const GONE = "sub_R18GonePlan07";
    subscriptions.set(GONE, subscription(GONE, s.customer, s.handle, "canceled"));
    checkout("cs_test_R18GoneSessn0007", s.customer, GONE, s.handle);
    const answer = await s.come("cs_test_R18GoneSessn0007");
    const after = await s.read();
    is("a first session whose subscription is not paying is written as before, pending", [after.subscriptionId, after.subscriptionActive, billingOf(answer)], [GONE, false, "pending"]);
  }
  part("Two ways back at once: the store changes after the old tab read it and before it writes");
  {
    const s = await shop(8);
    const OLD = "sub_R18OldPlan08", NEW = "sub_R18NewPlan08";
    subscriptions.set(OLD, subscription(OLD, s.customer, s.handle, "canceled"));
    subscriptions.set(NEW, subscription(NEW, s.customer, s.handle, "active"));
    checkout("cs_test_R18OldSession0008", s.customer, OLD, s.handle);
    checkout("cs_test_R18NewSession0008", s.customer, NEW, s.handle);
    await setSubscription(s.owner, { customerId: s.customer, subscriptionId: OLD, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
    await setSubscription(s.owner, { active: false });
    let fresh: string | null = null;
    meanwhile.set(OLD, async () => { fresh = billingOf(await s.come("cs_test_R18NewSession0008")); });
    const stale = await s.come("cs_test_R18OldSession0008");
    is("the new paid checkout, back first, starts the plan", fresh, "on");
    is("the old tab's write never lands: the store still runs sub_New, paid up", plan(await s.read()), [NEW, true, true, ""]);
    is("the old tab is told the store already pays, never that its plan is pending", billingOf(stale), "already");
  }
  {
    const s = await shop(9);
    const OLD = "sub_R18OldPlan09", NEW = "sub_R18NewPlan09";
    subscriptions.set(OLD, subscription(OLD, s.customer, s.handle, "canceled"));
    checkout("cs_test_R18OldSession0009", s.customer, OLD, s.handle);
    await setSubscription(s.owner, { customerId: s.customer, subscriptionId: OLD, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
    await setSubscription(s.owner, { active: false });
    meanwhile.set(OLD, async () => {
      await setSubscription(s.owner, { customerId: s.customer, subscriptionId: NEW, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
    });
    const stale = await s.come("cs_test_R18OldSession0009");
    is("the daily job adopts sub_New meanwhile: the old tab never writes over it", [plan(await s.read()), billingOf(stale)], [[NEW, true, true, ""], "already"]);
  }
  {
    const s = await shop(10);
    const OLD = "sub_R18OldPlan10", NEW = "sub_R18NewPlan10";
    subscriptions.set(OLD, subscription(OLD, s.customer, s.handle, "canceled"));
    checkout("cs_test_R18OldSession0010", s.customer, OLD, s.handle);
    await setSubscription(s.owner, { customerId: s.customer, subscriptionId: OLD, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
    await setSubscription(s.owner, { active: false });
    meanwhile.set(OLD, async () => { await setSubscription(s.owner, { customerId: s.customer, subscriptionId: NEW, active: false }); });
    const stale = await s.come("cs_test_R18OldSession0010");
    const after = await s.read();
    is("a newer record that is not paying is kept too, and the old tab is told it is not confirmed", [after.subscriptionId, after.subscriptionActive, billingOf(stale)], [NEW, false, "unconfirmed"]);
  }
  {
    const s = await shop(11);
    const NEW = "sub_R18SamePlan11";
    subscriptions.set(NEW, subscription(NEW, s.customer, s.handle, "active"));
    checkout("cs_test_R18SameSessn0011", s.customer, NEW, s.handle);
    let first: string | null = null;
    meanwhile.set(NEW, async () => { first = billingOf(await s.come("cs_test_R18SameSessn0011")); });
    const second = await s.come("cs_test_R18SameSessn0011");
    is("the same paid checkout back in two tabs at once: the first starts the plan", [first, plan(await s.read())], ["on", [NEW, true, true, ""]]);
    is("and the second is told the plan is on, the one it just paid for, not that the store already pays", billingOf(second), "on");
  }
  is("the way back only reads Stripe: nothing was created, changed or canceled there", posts, 0);
  done();
}

void main();
