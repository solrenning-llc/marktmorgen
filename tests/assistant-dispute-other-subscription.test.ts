/**
 * Synthetic provider replies only (issue #4440, rule 30): a dispute ends the Store assistant add-on only when the
 * disputed invoice is proven to be this add-on's own. A row of the invoice list that names another subscription, or
 * none, never cancels the add-on, never writes a dispute on it and never turns the service off; the reading is
 * unknown, nothing is written this run, and the next pass reads again. A real dispute of this subscription still
 * ends it and keeps it from being sold again.
 */
import { claimHandle, ensureStatsId, setAssistant, setAssistantPlan, setSubscription, storeForEmail } from "@/lib/store";
import { assistantRefusal, syncAssistant } from "@/lib/assistant-billing";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWN = "sub_SyncAssist01";

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_assistant_dispute_link_only";
  const now = Date.now();
  const owner = "dispute-link@example.com";
  const period = paidPeriod(now);
  const plan = { subscriptionId: OWN, active: true, period, cancelsAtEnd: false, disputedAt: "" };
  /** The rows the invoice list answers with this run. */
  let rows: Record<string, unknown>[] = [];
  let cancelAttempts = 0;
  let stopWrites = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request");
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === `/v1/subscriptions/${OWN}`) {
      return Response.json({ id: OWN, status: "active", cancel_at_period_end: false, items: { data: [{ current_period_start: period.start, current_period_end: period.end }] } });
    }
    if (method === "POST" && url.pathname === `/v1/subscriptions/${OWN}`) {
      stopWrites += 1;
      return Response.json({ id: OWN, status: "active", cancel_at_period_end: true });
    }
    if (method === "DELETE" && url.pathname === `/v1/subscriptions/${OWN}`) {
      cancelAttempts += 1;
      return Response.json({ id: OWN, status: "canceled" });
    }
    if (method === "GET" && url.pathname === "/v1/invoices") {
      is("the dispute lookup asks for this add-on's invoices", url.searchParams.get("subscription"), OWN);
      return Response.json({ object: "list", data: rows, has_more: false });
    }
    throw new Error("Unexpected provider operation: " + method + " " + url.pathname);
  }) as typeof fetch;
  const fresh = async () => {
    redis.clear();
    await claimHandle(owner, "disputelink", "Synthetic dispute link", "");
    await ensureStatsId(owner);
    await setSubscription(owner, { customerId: "cus_DisputeLink01", subscriptionId: "sub_DisputePlan01", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
    await setAssistant(owner, { on: true, notes: "Synthetic facts." });
    await setAssistantPlan(owner, plan);
    cancelAttempts = 0;
    stopWrites = 0;
  };
  try {
    part("The issue's case: another subscription's disputed invoice in the add-on's list");
    await fresh();
    rows = [{ id: "in_1", subscription: "sub_OtherB01", charge: { id: "ch_1", disputed: true } }];
    let result = await syncAssistant((await storeForEmail(owner))!, undefined, now / 1000);
    is("another subscription's disputed invoice does not stop this add-on", [result.assistantPlan?.active, Boolean(result.assistantPlan?.disputedAt), cancelAttempts], [true, false, 0]);
    is("nothing is written on the store this run", (await storeForEmail(owner))?.assistantPlan, plan);
    is("the add-on can still be told apart from a disputed one", assistantRefusal(result, now / 1000), "already");

    const unlinked: [string, Record<string, unknown>][] = [
      ["an expanded object of another subscription", { id: "in_2", subscription: { id: "sub_OtherB01" }, charge: { id: "ch_2", disputed: true } }],
      ["no subscription field at all", { id: "in_3", charge: { id: "ch_3", disputed: true } }],
      ["a null subscription", { id: "in_4", subscription: null, charge: { id: "ch_4", disputed: true } }],
      ["its own subscription on the invoice but another under its parent", { id: "in_5", subscription: OWN, parent: { subscription_details: { subscription: "sub_OtherB01" } }, charge: { id: "ch_5", disputed: true } }],
    ];
    for (const [label, row] of unlinked) {
      part("A disputed invoice with " + label + ": not proven this add-on's, so nothing is decided");
      await fresh();
      rows = [row];
      result = await syncAssistant((await storeForEmail(owner))!, undefined, now / 1000);
      is("not canceled, no dispute written, still on", [result.assistantPlan?.active, Boolean(result.assistantPlan?.disputedAt), cancelAttempts, (await storeForEmail(owner))?.assistantPlan], [true, false, 0, plan]);
    }

    part("An undisputed invoice of another subscription beside this add-on's own clean one: unknown, nothing written");
    await fresh();
    rows = [{ id: "in_6", subscription: OWN, charge: { id: "ch_6", disputed: false } }, { id: "in_7", subscription: "sub_OtherB01", charge: { id: "ch_7", disputed: false } }];
    // A plan no longer paid would set the stop on "not disputed": an unproven list must not read as that either.
    const unpaid = { ...(await storeForEmail(owner))!, subscriptionActive: false };
    result = await syncAssistant(unpaid, undefined, now / 1000);
    is("no stop, no cancel, the store as it was", [stopWrites, cancelAttempts, (await storeForEmail(owner))?.assistantPlan], [0, 0, plan]);

    part("Control: a disputed invoice of this very add-on ends it and keeps it from being sold again");
    for (const [label, row] of [
      ["its id as a string", { id: "in_8", subscription: OWN, charge: { id: "ch_8", disputed: true } }],
      ["its expanded object", { id: "in_9", subscription: { id: OWN }, charge: { id: "ch_9", disputed: true } }],
      ["named under its parent only", { id: "in_10", parent: { subscription_details: { subscription: OWN } }, charge: { id: "ch_10", disputed: true } }],
    ] as [string, Record<string, unknown>][]) {
      await fresh();
      // Another subscription's row beside it decides nothing; this add-on's own disputed row is proof enough.
      rows = [row, { id: "in_11", subscription: "sub_OtherB01", charge: { id: "ch_11", disputed: false } }];
      result = await syncAssistant((await storeForEmail(owner))!, undefined, now / 1000);
      is("own dispute (" + label + ") ends the add-on once", [result.assistantPlan?.active, Boolean(result.assistantPlan?.disputedAt), cancelAttempts], [false, true, 1]);
      is("own dispute (" + label + ") is never sold again", assistantRefusal(result, now / 1000), "disputed");
    }

    part("Control: this add-on's own clean invoices on a plan no longer paid set the stop, as before");
    await fresh();
    rows = [{ id: "in_12", subscription: OWN, charge: { id: "ch_12", disputed: false } }, { id: "in_13", subscription: OWN, charge: null }];
    await syncAssistant({ ...(await storeForEmail(owner))!, subscriptionActive: false }, undefined, now / 1000);
    is("not disputed: the stop is set, nothing canceled", [stopWrites, cancelAttempts], [1, 0]);
  } finally {
    globalThis.fetch = original;
  }
  done();
}

void main();
