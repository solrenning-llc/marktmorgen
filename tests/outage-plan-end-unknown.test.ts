/**
 * Outage drill (Claude 7, 13 November 2026; synthetic only).
 * A payment plan's end (lib/plans.ts, finishPlan/settlePlans) when Stripe's answer to
 * the subscription read is a 200 whose body is not the subscription (an empty object, as a proxy or a partial answer
 * can give). Unknown must never be "nothing to do": the plan must stay pending so a later run gives it its end.
 */
import { rememberPlan, settlePlans } from "@/lib/plans";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_outage_probe_plans";

const ACCOUNT = "acct_1ProbePlan0001";
const SESSION = "cs_test_probeplan000001";
let subscriptionBody: Record<string, unknown> = {};
const posts: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === `/checkout/sessions/${SESSION}`) {
    return answer({ id: SESSION, object: "checkout.session", status: "complete", subscription: "sub_ProbePlan0001", metadata: { kind: "plan", plan_payments: "3", plan_interval: "month" } });
  }
  if (path === "/subscriptions/sub_ProbePlan0001" && method === "GET") return answer(subscriptionBody);
  if (path === "/subscriptions/sub_ProbePlan0001" && method === "POST") {
    posts.push(String(init?.body));
    return answer({ id: "sub_ProbePlan0001", object: "subscription", cancel_at: 1 });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  part("A completed 3-payment plan; Stripe's subscription read answers 200 {} (not the subscription)");
  await rememberPlan(ACCOUNT, SESSION);
  subscriptionBody = {};
  const first = await settlePlans();
  console.log("  first run:", JSON.stringify(first));
  const [left] = await redis.pipeline([["SMEMBERS", "nl:plans:pending"]]);
  is("the plan is kept pending (its end is unknown, not 'nothing to do')", (left as string[]).length, 1);

  part("Stripe answers properly on the next run");
  subscriptionBody = { id: "sub_ProbePlan0001", object: "subscription", status: "active", billing_cycle_anchor: 1_790_000_000 };
  await settlePlans();
  is("the plan gets its end (cancel_at set once)", posts.length, 1);
  done();
}

void main();
