/** Synthetic provider replies only: actual add-on sync must close funded AI admission. */
import { claimHandle, ensureStatsId, setAssistant, setAssistantPlan, setSubscription, storeForEmail } from "@/lib/store";
import { syncAssistant, assistantRefusal } from "@/lib/assistant-billing";
import { assistantShown, askAssistant } from "@/lib/store-assistant";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_assistant_sync_only";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-assistant-sync-only";
  const now = Date.now();
  const owner = "sync-assistant@example.com";
  await claimHandle(owner, "syncassist", "Synthetic assistant", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_SyncAssist01", subscriptionId: "sub_SyncPlan01", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
  await setAssistant(owner, { on: true, notes: "Synthetic facts." });
  const period = paidPeriod(now);
  const plan = { subscriptionId: "sub_SyncAssist01", active: true, period, cancelsAtEnd: false, disputedAt: "" };
  let status = "past_due";
  let disputed = false;
  const sent: { method: string; path: string }[] = [];
  let modelCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.anthropic.com") {
      modelCalls += 1;
      throw new Error("Model must not be called after suspension");
    }
    if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request");
    const method = init?.method ?? "GET";
    sent.push({ method, path: url.pathname });
    is("billing stays on the platform account", new Headers(init?.headers).has("Stripe-Account"), false);
    if (method === "GET" && url.pathname === "/v1/subscriptions/sub_SyncAssist01") {
      return Response.json({ id: plan.subscriptionId, status, items: { data: [{ current_period_start: period.start, current_period_end: period.end }] } });
    }
    if (method === "GET" && url.pathname === "/v1/invoices") {
      is("dispute lookup belongs to this add-on", url.searchParams.get("subscription"), plan.subscriptionId);
      // Stripe's own list shape (lib/stripe-list.ts reads it exactly): each invoice with its id, the charge expanded with its id, has_more.
      return Response.json({ object: "list", data: [{ id: "in_SyncAssist01", charge: { id: "ch_SyncAssist01", disputed } }], has_more: false });
    }
    if (method === "DELETE" && url.pathname === "/v1/subscriptions/sub_SyncAssist01") return Response.json({ id: plan.subscriptionId, status: "canceled" });
    throw new Error("Unexpected provider operation: " + method + " " + url.pathname);
  }) as typeof fetch;
  try {
    for (const nextStatus of ["past_due", "unpaid", "canceled"]) {
      part("Known non-paying add-on: " + nextStatus);
      status = nextStatus;
      await setAssistantPlan(owner, plan);
      const before = (await storeForEmail(owner))!;
      is("fixture has paid AI admission", assistantShown(before, now), true);
      const after = await syncAssistant(before, undefined, now / 1000);
      is("actual sync persists inactive", [after.assistantPlan?.active, (await storeForEmail(owner))?.assistantPlan?.active], [false, false]);
      is("AI admission closes", assistantShown(after, now), false);
      is("a question cannot invoke the model", [(await askAssistant({ store: after, text: "Is it a PDF?", now })).ok, modelCalls], [false, 0]);
    }
    part("Confirmed dispute stops AI and prevents repurchase");
    status = "active";
    disputed = true;
    await setAssistantPlan(owner, plan);
    const after = await syncAssistant((await storeForEmail(owner))!, undefined, now / 1000);
    is("dispute is persisted and access closes", [after.assistantPlan?.active, Boolean(after.assistantPlan?.disputedAt), assistantShown(after, now)], [false, true, false]);
    is("subscription termination is requested once", sent.filter((row) => row.method === "DELETE").length, 1);
    is("repurchase is refused", assistantRefusal(after, now / 1000), "disputed");
    is("disputed question cannot invoke model", [(await askAssistant({ store: after, text: "Is it a PDF?", now })).ok, modelCalls], [false, 0]);
  } finally {
    globalThis.fetch = original;
  }
}
main().then(done).catch((error) => { console.error(error); process.exit(1); });
