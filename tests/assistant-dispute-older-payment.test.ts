/**
 * #5285 row #4443 (Codex X6's MEDIUM on the merged head 42c92511d0, still in main 86bd73f989): disputed()
 * (lib/assistant-billing.ts) read only the add-on's last three invoices, "by design", and took a longer list as
 * complete. A cardholder may dispute a payment months after it was made, so a dispute on the fourth-newest monthly
 * payment was never seen: the add-on kept running and kept being sold to the store. disputed() now reads every
 * invoice of the add-on inside the longest window in which a card payment can still be disputed; a page longer than
 * one request takes is unknown (it throws, nothing is ended or written this run), never "none disputed".
 * Synthetic Stripe only; no real request leaves the test.
 */
import { claimHandle, ensureStatsId, setAssistant, setAssistantPlan, setSubscription, storeForEmail } from "@/lib/store";
import { syncAssistant } from "@/lib/assistant-billing";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_assistant_dispute_older_only";
const owner = "dispute-older@example.com";
const SUB = "sub_DisputeOlder01";
const now = Date.now();
const period = paidPeriod(now);
const DAY = 86_400;
/** The add-on's monthly invoices, newest first: the one at `disputedAt` index has its charge disputed. */
let disputedIndex = 3;
let moreThanAPage = false;
const asked: URLSearchParams[] = [];
const invoices = () =>
  Array.from({ length: 8 }, (_, i) => ({
    id: `in_DisputeOlder0${i}`,
    subscription: SUB,
    created: Math.floor(now / 1000) - i * 30 * DAY,
    charge: { id: `ch_DisputeOlder0${i}`, disputed: i === disputedIndex },
  }));
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request");
  const method = init?.method ?? "GET";
  const one = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(url.pathname);
  if (one && method === "GET") {
    return Response.json({ id: one[1], status: "active", cancel_at_period_end: false, customer: "cus_DisputeOlder01", metadata: { addon: "assistant", assistant_for: "disputeolder" }, items: { data: [{ current_period_start: period.start, current_period_end: period.end }] } });
  }
  if (one && method === "DELETE") return Response.json({ id: one[1], status: "canceled" });
  if (one && method === "POST") return Response.json({ id: one[1], status: "active", cancel_at_period_end: true });
  if (method === "GET" && url.pathname === "/v1/invoices") {
    asked.push(url.searchParams);
    // Stripe's own list: newest first, from `created[gte]` on when given, at most `limit` rows, has_more beyond them.
    const since = Number(url.searchParams.get("created[gte]") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const rows = invoices().filter((row) => row.created >= since);
    return Response.json({ object: "list", data: rows.slice(0, limit), has_more: moreThanAPage || rows.length > limit });
  }
  throw new Error(`Unexpected synthetic Stripe request: ${method} ${url.pathname}`);
}) as typeof fetch;

async function freshStore() {
  redis.clear();
  asked.length = 0;
  await claimHandle(owner, "disputeolder", "Synthetic store", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_DisputeOlder01", subscriptionId: "sub_DisputeOlderPlan01", active: true, tier: "creator", trialEnds: 0, period });
  await setAssistant(owner, { on: true, notes: "Synthetic facts." });
  await setAssistantPlan(owner, { subscriptionId: SUB, active: true, period, cancelsAtEnd: false, disputedAt: "" });
}

async function main() {
  part("A dispute on the fourth-newest monthly payment ends the add-on");
  await freshStore();
  disputedIndex = 3;
  await syncAssistant((await storeForEmail(owner))!);
  const after = await storeForEmail(owner);
  is("RED: the dispute is written down and the add-on shut", [Boolean(after?.assistantPlan?.disputedAt), after?.assistantPlan?.active], [true, false]);
  is("the invoices are asked from inside the dispute window", asked.every((q) => Number(q.get("created[gte]")) > 0), true);

  part("No dispute in the window: the add-on runs on");
  await freshStore();
  disputedIndex = -1;
  await syncAssistant((await storeForEmail(owner))!);
  const fine = await storeForEmail(owner);
  is("nothing written down, the add-on active", [Boolean(fine?.assistantPlan?.disputedAt), fine?.assistantPlan?.active], [false, true]);

  part("More invoices in the window than one request reads: unknown, nothing written");
  await freshStore();
  disputedIndex = -1;
  moreThanAPage = true;
  await syncAssistant((await storeForEmail(owner))!);
  const unknown = await storeForEmail(owner);
  moreThanAPage = false;
  is("never 'none disputed' on a list read in part: the store stays as it was", [Boolean(unknown?.assistantPlan?.disputedAt), unknown?.assistantPlan?.active], [false, true]);
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
