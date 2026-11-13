/**
 * settlePlans reads the pending set and handles at most `limit` plans a run (lib/plans.ts). Members that never settle
 * (a Stripe reply that is not their own, "unread", or an account that throws) stay in the set. Before, the run took the
 * first `limit` in the set's own order, so once that many stuck plans had piled up, a plan opened today was never reached
 * and its end (cancel_at) never written: the buyer would keep being charged past the payments agreed (review LEVE,
 * lib/plans.ts slice, on #3086). Now the newest plans are taken first: a new plan always gets its end on the next run.
 *
 * Synthetic only: an in-memory Redis and a stand-in for Stripe.
 */
import { settlePlans } from "@/lib/plans";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plans_newest_first";
const NOW = Math.floor(Date.now() / 1000);
const FRESH = { account: "acct_FreshPlan00001", session: "cs_test_FreshPlan00001", sub: "sub_FreshPlan00001" };
const posts: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const account = new Headers(init?.headers).get("Stripe-Account");
  // Every stuck plan's account answers with an error, every run.
  if (account !== FRESH.account) return new Response(JSON.stringify({ error: { type: "api_error", message: "down" } }), { status: 500 });
  if (init?.method === "GET" && url.pathname === `/v1/checkout/sessions/${FRESH.session}`)
    return new Response(JSON.stringify({ id: FRESH.session, status: "complete", subscription: FRESH.sub, metadata: { kind: "plan", plan_payments: "3", plan_interval: "month" } }));
  if (init?.method === "GET" && url.pathname === `/v1/subscriptions/${FRESH.sub}`)
    return new Response(JSON.stringify({ id: FRESH.sub, status: "active", billing_cycle_anchor: NOW }));
  if (init?.method === "POST" && url.pathname === `/v1/subscriptions/${FRESH.sub}`) {
    posts.push(String(init.body));
    return new Response(JSON.stringify({ id: FRESH.sub, cancel_at: Number(new URLSearchParams(String(init.body)).get("cancel_at")) }));
  }
  throw new Error(`unexpected ${init?.method} ${url.pathname}`);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const stuck = Array.from({ length: 5 }, (_, i) => `acct_StuckPlan${String(i).padStart(5, "0")}|cs_test_Stuck${String(i).padStart(9, "0")}|${NOW - 30 * 86_400 + i}`);
  await redis.pipeline([["SADD", "nl:plans:pending", ...stuck]]);
  await redis.pipeline([["SADD", "nl:plans:pending", `${FRESH.account}|${FRESH.session}|${NOW - 60}`]]);
  const silent = console.error;
  console.error = () => {};
  const counts = await settlePlans(5);
  console.error = silent;
  is("five stuck plans and one opened today, five a run: the new plan gets its end", [counts.done, posts.length], [1, 1]);
  const left = (await redis.pipeline([["SMEMBERS", "nl:plans:pending"]]))[0] as string[];
  is("the new plan leaves the pending set; the stuck ones stay for the next run", [left.length, left.some((m) => m.startsWith(FRESH.account))], [5, false]);
  done();
}

void main();
