/** Synthetic provider replies only: actual add-on sync must close funded AI admission. */
import { claimHandle, ensureStatsId, setAssistant, setAssistantPlan, setSubscription, storeForEmail } from "@/lib/store";
import { readAssistantReturn, syncAssistant, assistantRefusal } from "@/lib/assistant-billing";
import { assistantShown, askAssistant } from "@/lib/store-assistant";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_assistant_sync_only";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-assistant-sync-only";
  const now = Date.now();
  const owner = "sync-assistant@example.com";
  /** A store with a paid plan and the assistant on, and no add-on written yet (a dispute, once written, stays). */
  const freshStore = async () => {
    redis.clear();
    await claimHandle(owner, "syncassist", "Synthetic assistant", "");
    await ensureStatsId(owner);
    await setSubscription(owner, { customerId: "cus_SyncAssist01", subscriptionId: "sub_SyncPlan01", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
    await setAssistant(owner, { on: true, notes: "Synthetic facts." });
  };
  await freshStore();
  const period = paidPeriod(now);
  const plan = { subscriptionId: "sub_SyncAssist01", active: true, period, cancelsAtEnd: false, disputedAt: "" };
  let status = "past_due";
  let disputed = false;
  const sent: { method: string; path: string }[] = [];
  let modelCalls = 0;
  /**
   * Rule 30: what each next GET of the add-on's subscription answers for. "own" is the subscription asked for; a string
   * is another subscription's id; null is a reply with no id at all; NULL_BODY is an HTTP 200 whose JSON body is `null`
   * itself. Empty: always its own.
   */
  const NULL_BODY = "null body";
  const replies: ("own" | string | null)[] = [];
  /** The same for the next GET of the checkout page: "own" is the page asked for. */
  let sessionReply: "own" | string | null = "own";
  let cancelSet = false;
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
      const next = replies.length ? replies.shift() : "own";
      if (next === NULL_BODY) return Response.json(null);
      const reply: Record<string, unknown> = { id: next === "own" ? plan.subscriptionId : next, status, cancel_at_period_end: cancelSet, items: { data: [{ current_period_start: period.start, current_period_end: period.end }] } };
      if (next === null) delete reply.id;
      return Response.json(reply);
    }
    if (method === "POST" && url.pathname === "/v1/subscriptions/sub_SyncAssist01") {
      cancelSet = new URLSearchParams(String(init?.body ?? "")).get("cancel_at_period_end") === "true";
      return Response.json({ id: plan.subscriptionId, status, cancel_at_period_end: cancelSet });
    }
    if (method === "GET" && url.pathname === "/v1/checkout/sessions/cs_test_SyncAssistReturn01") {
      if (sessionReply === NULL_BODY) return Response.json(null);
      const page: Record<string, unknown> = { id: sessionReply === "own" ? "cs_test_SyncAssistReturn01" : sessionReply, mode: "subscription", customer: "cus_SyncAssist01", subscription: plan.subscriptionId, metadata: { addon: "assistant", assistant_for: "syncassist" } };
      if (sessionReply === null) delete page.id;
      return Response.json(page);
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

    // Rule 30 (from #2517): a Stripe reply decides only when it is the subscription asked for.
    const stored = async () => (await storeForEmail(owner))?.assistantPlan;
    for (const [label, other] of [["another subscription's id", "sub_SomebodyElse01"], ["no id", null], ["a null body", NULL_BODY]] as const) {
      part("Sync on a reply with " + label + ": nothing is decided, the store is left as it was");
      disputed = false;
      status = "past_due";
      replies.length = 0;
      replies.push(other);
      await freshStore();
      await setAssistantPlan(owner, plan);
      const kept = await syncAssistant((await storeForEmail(owner))!, undefined, now / 1000);
      is("the stored add-on is the one asked for, unchanged", [kept.assistantPlan, await stored()], [plan, plan]);

      part("Sync on a disputed add-on whose reply has " + label + ": not ended on it, retried on the next pass");
      status = "active";
      disputed = true;
      replies.length = 0;
      replies.push(other);
      sent.length = 0;
      await freshStore();
      await setAssistantPlan(owner, plan);
      const untouched = await syncAssistant((await storeForEmail(owner))!, undefined, now / 1000);
      is("no subscription is ended and no dispute written on that reply", [sent.filter((row) => row.method === "DELETE").length, untouched.assistantPlan, await stored()], [0, plan, plan]);

      part("Sync after setting the stop, re-read with " + label + ": the stop stays at Stripe, the store is not rewritten from it");
      disputed = false;
      status = "active";
      cancelSet = false;
      replies.length = 0;
      replies.push("own", other);
      await freshStore();
      await setAssistantPlan(owner, plan);
      const unpaid = { ...(await storeForEmail(owner))!, subscriptionActive: false };
      const reread = await syncAssistant(unpaid, undefined, now / 1000);
      is("the stop is asked of Stripe for this add-on, and the store keeps what it knew", [cancelSet, reread.assistantPlan, await stored()], [true, plan, plan]);

      part("Return from checkout, subscription read with " + label + ": no add-on is granted on it");
      status = "active";
      replies.length = 0;
      replies.push(other);
      await freshStore();
      const returned = await readAssistantReturn((await storeForEmail(owner))!, "cs_test_SyncAssistReturn01").then(
        (value) => (value === null ? "nothing" : value),
        () => "unknown",
      );
      is("no plan comes back on that reply", typeof returned === "string" ? "no plan" : "a plan for " + returned.subscriptionId, "no plan");
    }
    for (const [label, other] of [["another page's id", `cs_test_${"S".repeat(20)}`], ["no id", null], ["a null body", NULL_BODY]] as const) {
      part("Return from checkout, Stripe's page read with " + label + ": no add-on is granted on it");
      status = "active";
      replies.length = 0;
      sessionReply = other;
      await freshStore();
      const returned = await readAssistantReturn((await storeForEmail(owner))!, "cs_test_SyncAssistReturn01").then(
        (value) => (value === null ? "nothing" : value),
        () => "unknown",
      );
      is("no plan comes back on that page", typeof returned === "string" ? "no plan" : "a plan for " + returned.subscriptionId, "no plan");
    }
    sessionReply = "own";
    replies.length = 0;
    await freshStore();
    part("Control: the same return with the subscription's own reply grants it");
    const own = await readAssistantReturn((await storeForEmail(owner))!, "cs_test_SyncAssistReturn01");
    is("its own reply is read as before", [own?.subscriptionId, own?.active], [plan.subscriptionId, true]);
  } finally {
    globalThis.fetch = original;
  }
}
main().then(done).catch((error) => { console.error(error); process.exit(1); });
