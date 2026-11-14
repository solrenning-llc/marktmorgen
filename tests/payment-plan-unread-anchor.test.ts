/**
 * A payment plan, or a membership that ends after a set number of payments, is never let go of the plans job's list
 * on a subscription reply that does not say where its payments start (lib/plans.ts finishPlan and settlePlans;
 * CX-123 rule 24, money).
 *
 * The defect this file was written around: finishPlan answered "gone" when the subscription reply carried no
 * `billing_cycle_anchor` (and no `trial_end`), and settlePlans then removed the plan from nl:plans:pending (SREM). An
 * unreadable reply became "never ends": the plan was never given its `cancel_at`, and it charged after its last
 * payment. Now such a reply is unknown: the run counts it as failed, nothing is written, and the plan stays on the
 * list for the next run.
 *
 * Checked: an anchor missing, null or in text keeps the plan pending and writes nothing; once Stripe's reply reads, the
 * plan is given its end and let go (control). Stripe is a stand-in.
 */
import { finishPlan, rememberPlan, settlePlans } from "@/lib/plans";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_unread_anchor_only";

const ACCOUNT = "acct_1TestPlansUnr1";
const ANCHOR = Date.UTC(2026, 0, 31, 15, 0, 0) / 1000;
const SESSION = "cs_test_unreadanchor0001";
const SUB = "sub_unreadanchor0001";
let subscription: Record<string, unknown> = {};
const updates: URLSearchParams[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === `/checkout/sessions/${SESSION}`) return answer({ id: SESSION, status: "complete", subscription: SUB, metadata: { store: "harbor", kind: "plan", plan_payments: "3", plan_interval: "month" } });
  if (path === `/subscriptions/${SUB}` && method === "GET") return answer(subscription);
  if (path === `/subscriptions/${SUB}` && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    updates.push(body);
    subscription = { ...subscription, cancel_at: Number(body.get("cancel_at")) };
    return answer(subscription);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const pending = async () => ((await redis.pipeline([["SMEMBERS", "nl:plans:pending"]]))[0] as string[]).filter((m) => m.startsWith(`${ACCOUNT}|${SESSION}|`)).length;
  const errors = console.error;

  part("A subscription reply that does not say where the payments start keeps the plan pending");
  await rememberPlan(ACCOUNT, SESSION);
  for (const [what, anchor] of [["no anchor", undefined], ["the anchor null", null], ["the anchor in text", String(ANCHOR)]] as [string, unknown][]) {
    subscription = { id: SUB, object: "subscription", status: "active", cancel_at: null, ...(anchor === undefined ? {} : { billing_cycle_anchor: anchor }) };
    console.error = () => {};
    let run;
    try {
      run = await settlePlans();
    } finally {
      console.error = errors;
    }
    is(`${what}: counted as failed, not dropped, still pending, nothing written`, [run.failed, run.dropped, await pending(), updates.length], [1, 0, 1, 0]);
  }
  is("finishPlan itself never answers \"gone\" on it", await finishPlan(ACCOUNT, SESSION).then((state) => state, () => "unknown"), "unknown");

  part("Control: once the reply reads, the plan is given its end and let go");
  subscription = { id: SUB, object: "subscription", status: "active", cancel_at: null, billing_cycle_anchor: ANCHOR };
  const run = await settlePlans();
  is("given its end at the close of the third period, and let go", [run.done, await pending(), Number(updates[0]?.get("cancel_at"))], [1, 0, Date.UTC(2026, 3, 30, 15, 0, 0) / 1000]);
  done();
}

void main();
