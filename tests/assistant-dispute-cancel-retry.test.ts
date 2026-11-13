/**
 * A disputed payment of the Store assistant add-on ends its subscription
 * (lib/assistant-billing.ts, syncAssistant). Writing down the dispute is not
 * proof the subscription was cancelled: while Stripe still shows it active,
 * every sync asks Stripe again to cancel it, so the charge never goes on with
 * the assistant off (issue #4439, Codex X8, HIGH). Once Stripe shows it
 * cancelled, nothing more is asked.
 */
import { claimHandle, ensureStatsId, setAssistant, setAssistantPlan, setSubscription, storeForEmail } from "@/lib/store";
import { syncAssistant } from "@/lib/assistant-billing";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "sub_SyncAssist01";
let status = "active";
let deletes = 0;
let failDeletes = 0;
async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_assistant_dispute_retry";
  console.error = () => {};
  const now = Date.now();
  const owner = "dispute-retry@example.com";
  const period = paidPeriod(now);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === `/v1/subscriptions/${ID}`) return Response.json({ id: ID, status, cancel_at_period_end: false, items: { data: [{ current_period_start: period.start, current_period_end: period.end }] } });
    if (method === "GET" && url.pathname === "/v1/invoices") return Response.json({ object: "list", data: [{ id: "in_SyncAssistDisputed", charge: { id: "ch_SyncAssist01", disputed: true } }], has_more: false });
    if (method === "DELETE" && url.pathname === `/v1/subscriptions/${ID}`) {
      deletes += 1;
      if (failDeletes > 0) {
        failDeletes -= 1;
        return Response.json({ error: { message: "synthetic outage" } }, { status: 500 });
      }
      status = "canceled";
      return Response.json({ id: ID, status: "canceled" });
    }
    throw new Error("Unexpected provider operation: " + method + " " + url.pathname);
  }) as typeof fetch;

  redis.clear();
  await claimHandle(owner, "disputeretry", "Synthetic assistant", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_DisputeRetry01", subscriptionId: "sub_DisputePlan01", active: true, tier: "creator", trialEnds: 0, period });
  await setAssistant(owner, { on: true, notes: "Synthetic facts." });
  await setAssistantPlan(owner, { subscriptionId: ID, active: true, period, cancelsAtEnd: false, disputedAt: "" });

  part("The first cancellation fails");
  failDeletes = 1;
  const first = await syncAssistant((await storeForEmail(owner))!, undefined, now / 1000);
  is("off at once, the dispute written", [first.assistantPlan?.active, Boolean(first.assistantPlan?.disputedAt)], [false, true]);
  is("one cancellation asked", deletes, 1);

  part("Stripe still shows it active: asked again");
  const second = await syncAssistant((await storeForEmail(owner))!, undefined, now / 1000 + 100);
  is("a still-active disputed add-on is cancelled again", deletes, 2);
  is("still off, the dispute kept", [second.assistantPlan?.active, Boolean(second.assistantPlan?.disputedAt)], [false, true]);

  part("Cancelled at Stripe: nothing more asked");
  await syncAssistant((await storeForEmail(owner))!, undefined, now / 1000 + 200);
  is("no third cancellation", deletes, 2);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
