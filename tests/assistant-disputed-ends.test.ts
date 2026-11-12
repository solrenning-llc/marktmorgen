/**
 * A store whose Store assistant payment was disputed has the add-on ended at once and never sold again
 * (lib/assistant-billing.ts, syncAssistant). The defects this file was written around:
 *   1. The DELETE that ends the disputed subscription was tried once; when Stripe did not take it, the dispute was
 *      written down anyway, and every later sync skipped the subscription because the mark was already there, so
 *      Stripe kept charging the creator every month for an add-on the store no longer gave.
 *   2. A second add-on subscription in good standing for the same store (a checkout opened before the dispute and
 *      paid after it) was adopted by the daily sync (applyListedAssistant): the mark stayed and the add-on stayed shut,
 *      but nothing ended that subscription either, so it charged every month for nothing.
 * Now every sync ends, at Stripe, an add-on subscription still in good standing on a store whose add-on was disputed,
 * until Stripe says it is ended. Synthetic Stripe only; no real request leaves the test.
 */
import { claimHandle, ensureStatsId, setAssistant, setAssistantPlan, setSubscription, storeForEmail } from "@/lib/store";
import { applyListedAssistant, syncAssistant } from "@/lib/assistant-billing";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_assistant_disputed_ends_only";
const owner = "disputed-ends@example.com";
const now = Date.now();
const period = paidPeriod(now);
/** Stripe's status of each add-on subscription; a DELETE Stripe takes makes it "canceled". */
const status = new Map<string, string>();
const deletes: string[] = [];
let refuseDeletes = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request");
  const method = init?.method ?? "GET";
  const one = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(url.pathname);
  if (one && method === "DELETE") {
    deletes.push(one[1]);
    if (refuseDeletes > 0) {
      refuseDeletes -= 1;
      return Response.json({ error: { type: "api_error", message: "Something went wrong on Stripe's end." } }, { status: 500 });
    }
    status.set(one[1], "canceled");
    return Response.json({ id: one[1], status: "canceled" });
  }
  if (one && method === "GET") {
    return Response.json({ id: one[1], status: status.get(one[1]) ?? "active", cancel_at_period_end: false, customer: "cus_DisputedEnds01", metadata: { addon: "assistant", assistant_for: "disputedends" }, items: { data: [{ current_period_start: period.start, current_period_end: period.end }] } });
  }
  if (one && method === "POST") return Response.json({ id: one[1], status: status.get(one[1]) ?? "active", cancel_at_period_end: true });
  if (method === "GET" && url.pathname === "/v1/invoices") {
    const disputed = url.searchParams.get("subscription") === "sub_DisputedFirst01";
    return Response.json({ object: "list", data: [{ id: "in_DisputedEnds01", charge: { id: "ch_DisputedEnds01", disputed } }], has_more: false });
  }
  throw new Error(`Unexpected synthetic Stripe request: ${method} ${url.pathname}`);
}) as typeof fetch;

async function freshStore() {
  redis.clear();
  status.clear();
  deletes.length = 0;
  await claimHandle(owner, "disputedends", "Synthetic store", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_DisputedEnds01", subscriptionId: "sub_DisputedPlan01", active: true, tier: "creator", trialEnds: 0, period });
  await setAssistant(owner, { on: true, notes: "Synthetic facts." });
  await setAssistantPlan(owner, { subscriptionId: "sub_DisputedFirst01", active: true, period, cancelsAtEnd: false, disputedAt: "" });
}

async function main() {
  part("A disputed add-on whose ending Stripe did not take is ended by the next sync");
  await freshStore();
  refuseDeletes = 1;
  await syncAssistant((await storeForEmail(owner))!);
  const marked = await storeForEmail(owner);
  is("the dispute is written down and the add-on shut", [Boolean(marked?.assistantPlan?.disputedAt), marked?.assistantPlan?.active], [true, false]);
  is("Stripe refused the first ending", [deletes, status.get("sub_DisputedFirst01") ?? "active"], [["sub_DisputedFirst01"], "active"]);
  await syncAssistant((await storeForEmail(owner))!);
  is("the next sync ends it at Stripe", status.get("sub_DisputedFirst01"), "canceled");
  deletes.length = 0;
  await syncAssistant((await storeForEmail(owner))!);
  is("once ended, it is not asked to end again", deletes, []);

  part("A second add-on subscription in good standing on a disputed store is ended, never left charging");
  await freshStore();
  refuseDeletes = 0;
  await syncAssistant((await storeForEmail(owner))!);
  is("the first is ended at the dispute", status.get("sub_DisputedFirst01"), "canceled");
  const second = { id: "sub_DisputedSecond01", object: "subscription", status: "active", cancel_at_period_end: false, customer: "cus_DisputedEnds01", metadata: { addon: "assistant", assistant_for: "disputedends" }, items: { data: [{ current_period_start: period.start, current_period_end: period.end }] } };
  await applyListedAssistant(second);
  const after = await storeForEmail(owner);
  is("the dispute mark stays and the add-on stays shut", [Boolean(after?.assistantPlan?.disputedAt), after?.assistantPlan?.active], [true, false]);
  is("the second subscription is ended at Stripe", status.get("sub_DisputedSecond01"), "canceled");
  done();
}

void main();
