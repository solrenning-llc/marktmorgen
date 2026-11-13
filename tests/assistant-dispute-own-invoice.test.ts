/**
 * A disputed payment ends the Store assistant add-on (lib/assistant-billing.ts,
 * disputed and syncAssistant) only when the disputed invoice belongs to that
 * add-on's subscription. A row of the invoice list that names another
 * subscription, or none, does not prove the link: it never cancels the add-on,
 * writes a dispute or turns the assistant off (issue #4440, Codex X8, HIGH).
 * The add-on's own disputed invoice still ends it.
 */
import { claimHandle, ensureStatsId, setAssistant, setAssistantPlan, setSubscription, storeForEmail } from "@/lib/store";
import { syncAssistant } from "@/lib/assistant-billing";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "sub_SyncAssist01";
let invoiceRow: Record<string, unknown> = {};
let deletes = 0;
async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_assistant_dispute_own";
  console.error = () => {};
  const now = Date.now();
  const owner = "dispute-own@example.com";
  const period = paidPeriod(now);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === `/v1/subscriptions/${ID}`) return Response.json({ id: ID, status: "active", cancel_at_period_end: false, items: { data: [{ current_period_start: period.start, current_period_end: period.end }] } });
    if (method === "GET" && url.pathname === "/v1/invoices") return Response.json({ object: "list", data: [invoiceRow], has_more: false });
    if (method === "DELETE" && url.pathname === `/v1/subscriptions/${ID}`) {
      deletes += 1;
      return Response.json({ id: ID, status: "canceled" });
    }
    throw new Error("Unexpected provider operation: " + method + " " + url.pathname);
  }) as typeof fetch;

  const sync = async (row: Record<string, unknown>) => {
    redis.clear();
    deletes = 0;
    await claimHandle(owner, "disputeown", "Synthetic assistant", "");
    await ensureStatsId(owner);
    await setSubscription(owner, { customerId: "cus_DisputeOwn01", subscriptionId: "sub_DisputeOwnPlan", active: true, tier: "creator", trialEnds: 0, period });
    await setAssistant(owner, { on: true, notes: "Synthetic facts." });
    await setAssistantPlan(owner, { subscriptionId: ID, active: true, period, cancelsAtEnd: false, disputedAt: "" });
    invoiceRow = row;
    const after = await syncAssistant((await storeForEmail(owner))!, undefined, now / 1000);
    return [after.assistantPlan?.active, Boolean(after.assistantPlan?.disputedAt), deletes];
  };

  part("Another subscription's disputed invoice");
  is("does not stop this add-on", await sync({ id: "in_1", subscription: "sub_OtherB01", charge: { id: "ch_1", disputed: true } }), [true, false, 0]);
  part("A disputed invoice that names no subscription");
  is("does not stop it either", await sync({ id: "in_2", charge: { id: "ch_2", disputed: true } }), [true, false, 0]);
  part("Control: the add-on's own disputed invoice");
  is("ends it", await sync({ id: "in_3", subscription: ID, charge: { id: "ch_3", disputed: true } }), [false, true, 1]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
