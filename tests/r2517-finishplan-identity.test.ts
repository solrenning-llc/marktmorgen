// Claude 3 (CX-116) local proof for #2517, rule 30 (same class outside the diff).
// lib/plans.ts finishPlan reads GET /subscriptions/:id and decides from a reply
// whose own id is not checked. A reply for another (or no) subscription with
// cancel_at set, or status canceled, ends the work as "done" without giving the
// requested payment plan its end (cancel_at), so its charges are never capped.
// Expected RED on 69d41c18f.
import { finishPlan } from "@/lib/plans";
import { done, is } from "./check";
const account = "acct_ProbeFinish0001";
const session = "cs_test_ProbeFinish0001";
const sub = "sub_ProbeFinish0001";
let subBody: Record<string, unknown> = {};
const posts: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("unexpected host");
  if (init?.method === "GET" && url.pathname === `/v1/checkout/sessions/${session}`)
    return new Response(JSON.stringify({ id: session, status: "complete", subscription: sub, metadata: { kind: "plan", plan_payments: "3", plan_interval: "month" } }));
  if (init?.method === "GET" && url.pathname === `/v1/subscriptions/${sub}`) return new Response(JSON.stringify(subBody));
  // Stripe answers an update with the whole subscription, the end just set included (Codex S on #3086: the id alone
  // does not prove the end was written, so this stand-in echoes it as Stripe does).
  if (init?.method === "POST" && url.pathname === `/v1/subscriptions/${sub}`) { posts.push(String(init.body)); return new Response(JSON.stringify({ id: sub, cancel_at: Number(new URLSearchParams(String(init.body)).get("cancel_at")) })); }
  throw new Error(`unexpected ${init?.method} ${url.pathname}`);
}) as typeof fetch;
async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_probe_finish_only";
  // Control: the requested subscription, not yet ended, gets its cancel_at.
  posts.length = 0; subBody = { id: sub, status: "active", billing_cycle_anchor: 1_800_000_000 };
  is("control: own reply gives the plan its end", [await finishPlan(account, session), posts.length], ["done", 1]);
  for (const [name, body] of [
    ["different id with cancel_at", { id: "sub_SomeoneElse00001", status: "active", cancel_at: 1_900_000_000, billing_cycle_anchor: 1_800_000_000 }],
    ["no id, status canceled", { status: "canceled", billing_cycle_anchor: 1_800_000_000 }],
  ] as const) {
    posts.length = 0; subBody = body as Record<string, unknown>;
    const state = await finishPlan(account, session);
    // A reply that is not the requested subscription proves nothing: it must not
    // be "done" without the cancel_at POST (it should stay unsettled or throw).
    is(`${name}: not settled as done without capping the plan`, state === "done" && posts.length === 0, false);
  }
  done();
}
main().catch(e => { console.error(e); process.exit(1); });
