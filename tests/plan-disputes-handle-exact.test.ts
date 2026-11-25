/**
 * A new plan dispute whose store is read by its handle (rule 24; the LOW
 * named by Claude 6, Claude 5 and Claude 1 on #2884). storeForHandle answers
 * null both for "no store" and for "not read", so an unknown reply of the
 * handle's GET marked the dispute `unmatched:<now>`, counted no failure and
 * the run said it was complete. Read exactly now (storeForHandleExactly): an
 * unknown reply throws, the dispute is counted as failed and is not
 * remembered, so the next run reads it again whole.
 * Synthetic only: the Redis stub and a stand-in for Stripe.
 */
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SEEN_KEY, syncPlanDisputes } from "@/lib/plan-disputes";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_dispute_handle_exact";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const owner = "plan-dispute-handle@example.com";
const handle = "plan-dispute-handle-shop";
const SUB = "sub_PlanDisputeHandle1";
const DISPUTE = "du_HandleExact1";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && (init?.method ?? "GET") === "GET") {
    if (url.pathname === "/v1/disputes") {
      return Response.json({
        object: "list",
        has_more: false,
        data: [{
          id: DISPUTE,
          object: "dispute",
          status: "needs_response",
          created: NOW - DAY,
          charge: { id: "ch_HandleExact1", invoice: { id: "in_HandleExact1", subscription: SUB, lines: { data: [{ period: { start: NOW - 10 * DAY, end: NOW + 20 * DAY } }] } } },
        }],
      });
    }
    if (url.pathname === `/v1/subscriptions/${SUB}`) return Response.json({ id: SUB, metadata: { store: handle }, customer: "cus_PlanDisputeHandle1" });
  }
  return new Response(JSON.stringify({ error: { message: "missing" } }), { status: 404 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const handleKey = `nl:store:handle:${handle}`;

async function setup(): Promise<void> {
  redis.clear();
  await claimHandle(owner, handle, "Plan dispute handle shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_PlanDisputeHandle1", subscriptionId: SUB, active: true, tier: "pro", cycle: "month", period: paidPeriod() });
}

async function seen(): Promise<unknown> {
  return (await real([["HGET", SEEN_KEY, DISPUTE]]))[0];
}

async function main(): Promise<void> {
  console.error = () => {};

  part("Control: a readable handle writes the dispute on its store");
  await setup();
  const healthy = await syncPlanDisputes(Date.now() + 10_000, NOW);
  is("recorded, and the run is complete", [healthy.recorded, healthy.failed, healthy.complete], [1, 0, true]);
  is("the store carries it", (await storeForEmail(owner))?.planDisputes?.map((kept) => kept.id), [DISPUTE]);

  for (const [label, reply] of [["undefined", [undefined]], ["no reply", []], ["a number", [7]], ["an empty string", [""]]] as const) {
    part(`The handle's GET answers ${label}`);
    await setup();
    redis.pipeline = (async (c: Commands) => (c.length === 1 && c[0]?.[0] === "GET" && c[0][1] === handleKey ? [...reply] : real(c))) as typeof redis.pipeline;
    let counts: Awaited<ReturnType<typeof syncPlanDisputes>> | "rejected";
    try {
      counts = await syncPlanDisputes(Date.now() + 10_000, NOW);
    } catch {
      counts = "rejected";
    } finally {
      redis.pipeline = real;
    }
    is("never a complete run on a guess", counts !== "rejected" && counts.complete, false);
    is("counted as failed, not as unmatched", counts === "rejected" ? "rejected" : [counts.failed, counts.unmatched], [1, 0]);
    const mark = await seen();
    is("not remembered as unmatched", typeof mark === "string" && mark.startsWith("unmatched:"), false);
    is("nothing written on the store", (await storeForEmail(owner))?.planDisputes ?? [], []);
  }
  done();
}

void main();
