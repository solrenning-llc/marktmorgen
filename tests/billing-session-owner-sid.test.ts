/**
 * Money HIGH (found by Claude 7 on main 4865799f53): the way back from a plan checkout (app/api/billing/return)
 * took a session as this store's when its `metadata[store]` was the store's CURRENT address, with no other check
 * (lib/billing.ts sessionOwnedBy). An address is a name, not a store: store A pays under "x", moves to another
 * address and lets "x" go; after the quarantine (RELEASE_QUARANTINE_DAYS) store B of the same owner takes "x", and
 * opening /api/billing/return?session_id=<A's session> wrote A's subscription on B as well, so one payment paid two
 * stores. A checkout now carries the store's own id (`store_sid`, on the session and on its subscription) and the
 * way back takes it only on that store; an earlier session without it is taken only with this store's own customer,
 * and never when another store of the account keeps that customer or that subscription. The daily sync's ownedBy
 * refuses a subscription whose `store_sid` names another store. The route runs whole; Stripe is a stand-in.
 */
import { NextRequest } from "next/server";
import { GET as back } from "@/app/api/billing/return/route";
import { HELD_SLACK_DAYS, createBillingCheckout, findStoreSubscriptions, ownedBy } from "@/lib/billing";
import { applyListedAssistant } from "@/lib/assistant-billing";
import { syncSubscriptions } from "@/lib/billing-sync";
import { refusePlanIfClosing } from "@/lib/closing-plan-guard";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { UnknownReplyError } from "@/lib/redis-reply";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { RELEASE_QUARANTINE_DAYS, claimHandle, createStore, ensureStatsId, releaseHandle, renameHandle, setSubscription, storeForEmail, storeForId, storeRef, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_session_owner_synthetic_only";
delete process.env.STRIPE_CONNECT_API_BASE;

const now = Math.floor(Date.now() / 1000);
type Reply = Record<string, unknown>;
const sessions = new Map<string, Reply>();
const subscriptions = new Map<string, Reply>();
let lastCheckout: URLSearchParams | null = null;
/** Every subscription ended at Stripe (DELETE), by id. */
const ended: string[] = [];
/** What Stripe's list of subscriptions holds, for the daily sync. */
let listed: Reply[] = [];
/** What Stripe's subscription search answers (observeStoreSubscriptions). */
let searched: Reply[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
    lastCheckout = new URLSearchParams(String(init?.body ?? ""));
    return json({ id: "cs_test_SessionOwnerNew0001", url: "https://checkout.stripe.test/c/pay" });
  }
  const session = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_\w+)$/);
  if (session) return sessions.has(session[1]) ? json(sessions.get(session[1])) : json({ error: { message: "No such checkout session" } }, 404);
  const sub = url.pathname.match(/^\/v1\/subscriptions\/(sub_\w+)$/);
  if (sub && method === "DELETE") {
    ended.push(sub[1]);
    return json({ ...(subscriptions.get(sub[1]) ?? { id: sub[1] }), status: "canceled" });
  }
  if (sub && method === "GET") return subscriptions.has(sub[1]) ? json(subscriptions.get(sub[1])) : json({ error: { message: "No such subscription" } }, 404);
  if (url.pathname === "/v1/subscriptions/search" && method === "GET") return json({ object: "search_result", data: searched, has_more: false, next_page: null });
  if (url.pathname === "/v1/subscriptions" && method === "GET") return json({ object: "list", data: listed, has_more: false, url: "/v1/subscriptions" });
  if (url.pathname.startsWith("/v1/prices") || url.pathname.startsWith("/v1/products") || url.pathname.startsWith("/v1/subscriptions") || url.pathname.startsWith("/v1/customers")) {
    return json({ object: "list", data: [], has_more: false });
  }
  return json({ error: { message: `no stand-in for ${method} ${url.pathname}` } }, 404);
}) as typeof fetch;

function subscription(id: string, customer: string, meta: Record<string, string>, made = now - 5 * 86_400): Reply {
  const start = made;
  const end = now + 25 * 86_400;
  return {
    id, object: "subscription", status: "active", customer, created: start,
    metadata: meta, cancel_at: null, cancel_at_period_end: false, pending_update: null,
    items: { object: "list", has_more: false, data: [{
      id: `si_${id.slice(4)}`, quantity: 1, current_period_start: start, current_period_end: end,
      price: { id: "price_SessOwnCreator1", currency: "usd", unit_amount: 6900, lookup_key: "nimbus_creator_month", recurring: { interval: "month", interval_count: 1 } },
    }] },
  };
}

function checkout(id: string, customer: string, subscriptionId: string, meta: Record<string, string>) {
  sessions.set(id, { id, object: "checkout.session", mode: "subscription", status: "complete", customer, subscription: subscriptionId, metadata: meta });
}

const billingOf = (response: Response) => new URL(response.headers.get("Location") ?? "https://x.test/").searchParams.get("billing");

/** Store A pays under `x`, moves to `x`+"new" and lets `x` go; after the quarantine store B of the same owner takes `x`. */
async function twoStores(n: number, meta: (a: Store) => Record<string, string>) {
  const owner = `sess-owner-${n}@example.com`;
  const x = `sessownx${n}`;
  await claimHandle(owner, x, `Session owner A ${n}`, "");
  await ensureStatsId(owner);
  const customer = `cus_SessOwnA${n}0000`;
  const sub = `sub_SessOwnA${n}0000`;
  const session = `cs_test_SessOwnA${n}000000000`;
  const a0 = (await storeForEmail(owner))!;
  // Bought before A let the address go, so at least the quarantine before B could take it.
  subscriptions.set(sub, subscription(sub, customer, meta(a0), now - 40 * 86_400));
  checkout(session, customer, sub, meta(a0));
  await setSubscription(owner, { customerId: customer, subscriptionId: sub, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  const renamed = await renameHandle(owner, `${x}new`);
  if (!renamed.ok) throw new Error(`rename: ${JSON.stringify(renamed)}`);
  const released = await releaseHandle(owner, x);
  if (!released.ok) throw new Error(`release: ${JSON.stringify(released)}`);
  // The quarantine is over: the address leads nowhere and may be taken again.
  await redis.pipeline([["DEL", `nl:store:handle:${x}`]]);
  const made = await createStore(owner, x, `Session owner B ${n}`, "");
  if (!made.ok) throw new Error(`create B: ${JSON.stringify(made)}`);
  const a = (await storeForId(a0.sid))!;
  const b = made.store;
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const comeTo = async (store: Store, id = session) =>
    back(new NextRequest(`https://marktmorgen.test/api/billing/return?session_id=${id}&store=${store.sid}`, { headers: { cookie } }));
  return { owner, x, a, b, sub, customer, session, comeTo };
}

async function main() {
  redis.clear();

  part("The defect: an earlier session (no store id) of store A, opened on store B that took A's let-go address");
  {
    const s = await twoStores(1, () => ({ store: `sessownx1` }));
    is("B holds the address A paid under; A keeps the subscription", [s.b.handle, s.a.subscriptionId, s.a.releasedHandles.includes(s.x)], [s.x, s.sub, true]);
    const answer = await s.comeTo(s.b);
    const b = (await storeForId(s.b.sid))!;
    is("B is told nothing was finished", billingOf(answer), "unfinished");
    is("B is not written A's subscription: one payment, one store", [b.subscriptionId, b.subscriptionActive, b.stripeCustomerId], [null, false, null]);
    is("A still keeps it", (await storeForId(s.a.sid))?.subscriptionId, s.sub);
    // The same hole reached the Store assistant (coordinator, 15 November 2026): with A's customer written on B, the
    // daily sync's applyListedAssistant gave B the add-on A bought under the address. B never takes A's customer now.
    const addOn = { ...subscription("sub_SessOwnAddOn10000", s.customer, { addon: "assistant", assistant_for: s.x }), status: "active" };
    is("A's assistant add-on, met in the list under the address B holds, is not B's", await applyListedAssistant(addOn), false);
    is("B has no add-on", (await storeForId(s.b.sid))?.assistantPlan ?? null, null);
  }

  part("The same earlier session when A's subscription does not read: B is written nothing, not even A's customer");
  {
    const s = await twoStores(4, () => ({ store: `sessownx4` }));
    const kept = subscriptions.get(s.sub)!;
    subscriptions.delete(s.sub);
    const answer = await s.comeTo(s.b);
    subscriptions.set(s.sub, kept);
    const b = (await storeForId(s.b.sid))!;
    is("told it is not confirmed", billingOf(answer), "unconfirmed");
    is("nothing written on B", [b.subscriptionId, b.subscriptionActive, b.stripeCustomerId], [null, false, null]);
  }

  part("The daily sync's ownedBy, an earlier subscription with no store id: B's by the owner's email only if made while B held the address");
  {
    const s = await twoStores(5, () => ({ store: `sessownx5` }));
    const record = { ...subscriptions.get(s.sub)!, customer: { id: s.customer, email: s.owner } };
    is("A's, made before B took the address: not B's", ownedBy(s.b, record), false);
    is("one made since B holds it: B's by the email, as before", ownedBy(s.b, { ...record, created: Math.floor(Date.now() / 1000) }), true);
    is("still A's, by its own customer", ownedBy(s.a, record), true);
  }

  part("One customer for the whole account (review of 7c3aae961): B paid before on the account's customer, its plan ended, then took A's address");
  {
    const s = await twoStores(6, () => ({ store: `sessownx6` }));
    // B pays on the account's one customer, as a second store's checkout does, and that plan ends.
    const own = "sub_SessOwnB60000000";
    subscriptions.set(own, subscription(own, s.customer, { store: s.x }, Math.floor(Date.now() / 1000)));
    await setSubscription(storeRef(s.b), { customerId: s.customer, subscriptionId: own, active: false, tier: "creator", cycle: "month", period: paidPeriod() });
    const before = (await storeForId(s.b.sid))!;
    is("B is on the account's customer, its own plan ended", [before.stripeCustomerId, before.subscriptionId, before.subscriptionActive], [s.customer, own, false]);
    const record = { ...subscriptions.get(s.sub)!, customer: { id: s.customer, email: s.owner } };
    listed = [record];
    await syncSubscriptions(Date.now() + 60_000);
    listed = [];
    const synced = (await storeForId(s.b.sid))!;
    is("the daily sync does not write A's subscription, which A keeps, on B", [synced.subscriptionId, synced.subscriptionActive], [own, false]);
    is("A still keeps it", (await storeForId(s.a.sid))?.subscriptionId, s.sub);
    const answer = await s.comeTo(before);
    const after = (await storeForId(s.b.sid))!;
    is("the way back with A's earlier session on B: not written", [billingOf(answer) === "on", after.subscriptionId, after.subscriptionActive], [false, own, false]);
  }

  part("One customer for the account, B closing (coordinator, 15 November 2026): B's closing never ends A's plan");
  {
    const s = await twoStores(8, () => ({ store: `sessownx8` }));
    const own = "sub_SessOwnB80000000";
    subscriptions.set(own, subscription(own, s.customer, { store: s.x }, Math.floor(Date.now() / 1000)));
    await setSubscription(storeRef(s.b), { customerId: s.customer, subscriptionId: own, active: false, tier: "creator", cycle: "month", period: paidPeriod() });
    const b = (await storeForId(s.b.sid))!;
    // B is in its closing day: its plan ended and its closing line has it.
    await redis.pipeline([["ZADD", FINAL_INDEX, Date.now() - 86_400_000, storeRef(b)]]);
    ended.length = 0;
    const result = await refusePlanIfClosing({ store: b, handle: s.x, subscriptionId: s.sub, customerId: s.customer });
    is("A's plan, which A keeps, is not B's to end: nothing done, A's plan untouched", [result, ended.includes(s.sub), (await storeForId(s.a.sid))?.subscriptionId], ["no", false, s.sub]);
    // The account's stores do not read: unknown, so nothing is ended (fail closed).
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => commands.some((c) => c[0] === "SMEMBERS") ? [] : real(commands)) as typeof redis.pipeline;
    let unknown = "resolved";
    try {
      await refusePlanIfClosing({ store: b, handle: s.x, subscriptionId: s.sub, customerId: s.customer });
    } catch (error) {
      unknown = error instanceof UnknownReplyError ? "unknown" : String(error);
    } finally {
      redis.pipeline = real;
    }
    is("an account read that does not read: unknown, and A's plan is not ended", [unknown, ended.includes(s.sub)], ["unknown", false]);
  }

  part("The store's own subscription, carrying its id, is found by the subscription search (review of 090840a90, HIGH)");
  {
    const owner = "sess-owner-find@example.com";
    await claimHandle(owner, "sessownfind", "Find own", "");
    await ensureStatsId(owner);
    const store = (await storeForEmail(owner))!;
    await setSubscription(owner, { customerId: "cus_SessOwnFind000", subscriptionId: null, active: false });
    const mine = { ...subscription("sub_SessOwnFind0000", "cus_SessOwnFind000", { store: "sessownfind", store_sid: store.sid }, Math.floor(Date.now() / 1000)), customer: { id: "cus_SessOwnFind000", email: owner } };
    searched = [mine];
    listed = [];
    const found = await findStoreSubscriptions((await storeForEmail(owner))!);
    searched = [];
    is("found live, so a lost way back never opens a second paid checkout beside it", found.live?.subscriptionId ?? null, "sub_SessOwnFind0000");
  }

  part("One customer for the account: the subscription search never gives B the plan A keeps (review of 090840a90)");
  {
    const s = await twoStores(9, () => ({ store: `sessownx9` }));
    const own = "sub_SessOwnB90000000";
    subscriptions.set(own, subscription(own, s.customer, { store: s.x }, Math.floor(Date.now() / 1000)));
    await setSubscription(storeRef(s.b), { customerId: s.customer, subscriptionId: own, active: false, tier: "creator", cycle: "month", period: paidPeriod() });
    const b = (await storeForId(s.b.sid))!;
    searched = [{ ...subscriptions.get(s.sub)!, status: "past_due", customer: { id: s.customer, email: s.owner } }];
    listed = [];
    let found: Awaited<ReturnType<typeof findStoreSubscriptions>> | string;
    try { found = await findStoreSubscriptions(b); } catch (error) { found = String(error); }
    searched = [];
    is("A's plan is neither B's live plan nor one B would end as lapsed", typeof found === "string" ? found : [found.live?.subscriptionId ?? null, found.lapsed], [null, []]);
  }

  part("The account's stores that do not read: the way back says unconfirmed and writes nothing (rule 24)");
  {
    const s = await twoStores(10, () => ({ store: `sessownx10` }));
    const own = "sub_SessOwnB10000000";
    subscriptions.set(own, subscription(own, s.customer, { store: s.x }, Math.floor(Date.now() / 1000)));
    await setSubscription(storeRef(s.b), { customerId: s.customer, subscriptionId: own, active: false, tier: "creator", cycle: "month", period: paidPeriod() });
    const b = (await storeForId(s.b.sid))!;
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => commands.some((c) => c[0] === "SMEMBERS") ? [] : real(commands)) as typeof redis.pipeline;
    let answer: Response;
    try { answer = await s.comeTo(b); } finally { redis.pipeline = real; }
    const after = (await storeForId(s.b.sid))!;
    is("unconfirmed, B unchanged", [billingOf(answer), after.subscriptionId, after.subscriptionActive], ["unconfirmed", own, false]);
  }

  part("A store with no id yet (an old record): its checkout carries no empty id, and an empty one reads as none");
  {
    const s = await twoStores(7, () => ({ store: `sessownx7`, store_sid: "" }));
    is("an empty store_sid on A's own session: read as none, so the old rules decide (its own customer)", billingOf(await s.comeTo(s.a)), "on");
  }

  part("The slack for clock skew stays inside the quarantine, so it can never reach another store's subscription");
  is("HELD_SLACK_DAYS < RELEASE_QUARANTINE_DAYS", HELD_SLACK_DAYS < RELEASE_QUARANTINE_DAYS, true);

  part("A session that carries its store's id is taken only on that store");
  {
    const s = await twoStores(2, (a) => ({ store: `sessownx2`, store_sid: a.sid }));
    is("on B, the store that took the address: refused", billingOf(await s.comeTo(s.b)), "unfinished");
    is("B still has no plan", (await storeForId(s.b.sid))?.subscriptionId ?? null, null);
    is("on A, whose id it carries (under its new address): taken", billingOf(await s.comeTo(s.a)), "on");
  }

  part("A store's own earlier session, no id, its first plan: still taken (control)");
  {
    const owner = "sess-owner-first@example.com";
    await claimHandle(owner, "sessownfirst", "First plan", "");
    await ensureStatsId(owner);
    const store = (await storeForEmail(owner))!;
    const sub = "sub_SessOwnFirst0000";
    subscriptions.set(sub, subscription(sub, "cus_SessOwnFirst000", { store: "sessownfirst" }, Math.floor(Date.now() / 1000) + 1));
    checkout("cs_test_SessOwnFirst0000000000", "cus_SessOwnFirst000", sub, { store: "sessownfirst" });
    const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
    const answer = await back(new NextRequest(`https://marktmorgen.test/api/billing/return?session_id=cs_test_SessOwnFirst0000000000&store=${store.sid}`, { headers: { cookie } }));
    is("the first plan is written", [billingOf(answer), (await storeForEmail(owner))?.subscriptionId], ["on", sub]);
  }

  part("A new checkout carries the store's id on the session and on its subscription");
  {
    const owner = "sess-owner-new@example.com";
    await claimHandle(owner, "sessownnew", "New checkout", "");
    await ensureStatsId(owner);
    const store = (await storeForEmail(owner))!;
    await createBillingCheckout(store, "https://marktmorgen.test").catch(() => "");
    is("metadata[store_sid] and subscription_data[metadata][store_sid] are the store's id",
      [lastCheckout?.get("metadata[store_sid]"), lastCheckout?.get("subscription_data[metadata][store_sid]")], [store.sid, store.sid]);
  }

  part("The daily sync's ownedBy: a subscription naming another store's id is never this store's");
  {
    const s = await twoStores(3, (a) => ({ store: `sessownx3`, store_sid: a.sid }));
    const record = subscriptions.get(s.sub)!;
    is("not B's, though B holds the address and the owner's email", ownedBy(s.b, { ...record, customer: { id: s.customer, email: s.owner } }), false);
    is("A's, by its own customer", ownedBy(s.a, { ...record, customer: { id: s.customer, email: s.owner } }), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
