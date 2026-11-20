/**
 * The way back from a creator's FIRST plan checkout (app/api/billing/return)
 * when Stripe cannot be asked about the subscription it made (synthetic).
 *
 * readStartedSubscription answers a subscription that could not be read as
 * `active: false` (tests/contract-billing-metadata.test.ts holds that it
 * grants no rights). The route already refuses to write that over a store
 * that pays (tests/billing-return-replay.test.ts, part 3), but a store with
 * no plan yet had it written down as a subscription that is not running: the
 * store's record named the new subscription, inactive, with a plan-ended date
 * of today, and it went into the line of ended plans (ENDED_INDEX) that the
 * daily closing job walks (lib/plan-closing.ts: holds the members' charges
 * and sends "your plan ended" notices). A creator who had just paid, or just
 * started a free trial, was recorded as a plan that ended: unknown became
 * "ended".
 *
 * Now nothing is written on an unknown reading: the store stays as it was
 * (no plan, no ended date, not in the line) and the creator is told the plan
 * is not confirmed yet; the studio and the daily job (lib/billing-sync.ts)
 * read it again. A first subscription Stripe really reports as not running
 * is still written as before (tests/billing-return-replay.test.ts, shop 7).
 */
import { NextRequest } from "next/server";
import { GET as back } from "@/app/api/billing/return/route";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { claimHandle, ensureStatsId, storeForEmail, storeRef } from "@/lib/store";
import { standingOf, ENDED_INDEX } from "@/lib/plan-standing";
import { TRIAL_DAYS } from "@/lib/plan";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_unread_first_synthetic";
delete process.env.STRIPE_CONNECT_API_BASE;

const now = Math.floor(Date.now() / 1000);
type Reply = Record<string, unknown>;
const sessions = new Map<string, Reply>();
const subscriptions = new Map<string, Reply>();
const unreadable = new Set<string>();
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
    return subscriptions.has(sub[1]) ? json(subscriptions.get(sub[1])) : json({ error: { message: "No such subscription" } }, 404);
  }
  return json({ error: { message: `no stand-in for ${method} ${url.pathname}` } }, 404);
}) as typeof fetch;

/** A legacy (unfunded) plan subscription in its free trial, as Stripe sends one in full. */
function trialing(id: string, customer: string, handle: string): Reply {
  const end = now + TRIAL_DAYS * 86_400;
  return {
    id, object: "subscription", status: "trialing", customer, created: now, trial_start: now, trial_end: end,
    metadata: { store: handle }, cancel_at: null, cancel_at_period_end: false, pending_update: null,
    items: { object: "list", has_more: false, data: [{
      id: `si_${id.slice(4)}`, quantity: 1, current_period_start: now, current_period_end: end,
      price: { id: "price_UnreadCreator1", currency: "usd", unit_amount: 6900, lookup_key: "nimbus_creator_month", recurring: { interval: "month", interval_count: 1 } },
    }] },
  };
}

const billingOf = (response: Response) => new URL(response.headers.get("Location") ?? "https://x.test/").searchParams.get("billing");

async function shop(n: number) {
  const owner = `unread-first-${n}@example.com`;
  const handle = `unreadfirst${n}`;
  await claimHandle(owner, handle, `Unread first shop ${n}`, "");
  await ensureStatsId(owner);
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const come = async (session: string) => back(new NextRequest(`https://marktmorgen.test/api/billing/return?session_id=${session}`, { headers: { cookie } }));
  const read = async () => (await storeForEmail(owner))!;
  return { owner, handle, come, read, customer: `cus_UnreadShop${n}00` };
}

async function inEndedLine(ref: string): Promise<boolean> {
  const [score] = await redisPipeline([["ZSCORE", ENDED_INDEX, ref]]);
  return score !== null && score !== undefined;
}

async function main() {
  redis.clear();

  part("A first checkout (a free trial just started) whose subscription Stripe could not be read on the way back");
  {
    const s = await shop(1);
    const SUB = "sub_UnreadFirst01";
    subscriptions.set(SUB, trialing(SUB, s.customer, s.handle));
    sessions.set("cs_test_UnreadFirstSess01", { id: "cs_test_UnreadFirstSess01", object: "checkout.session", mode: "subscription", status: "complete", customer: s.customer, subscription: SUB, metadata: { store: s.handle } });
    const before = await s.read();
    is("before: no plan, no ended date", [before.subscriptionId, before.subscriptionActive, before.planEndedAt, standingOf(before)], [null, false, "", "none"]);
    unreadable.add(SUB);
    const answer = await s.come("cs_test_UnreadFirstSess01");
    unreadable.delete(SUB);
    const after = await s.read();
    is("an unknown reading never records a plan that ended", [after.planEndedAt, standingOf(after)], ["", "none"]);
    is("and never puts the store in the line of ended plans", await inEndedLine(storeRef(after)), false);
    is("told the plan is not confirmed yet, never that it is pending as written", billingOf(answer), "unconfirmed");

    part("Control: once Stripe answers, the same way back starts the trial");
    const again = await s.come("cs_test_UnreadFirstSess01");
    const started = await s.read();
    is("the trial is written and the store is in it", [started.subscriptionId, started.subscriptionActive, started.planEndedAt, standingOf(started), billingOf(again)], [SUB, true, "", "trial", "on"]);
    is("and it is not in the line of ended plans", await inEndedLine(storeRef(started)), false);
  }
  is("the way back only reads Stripe", posts, 0);
  done();
}

void main();
