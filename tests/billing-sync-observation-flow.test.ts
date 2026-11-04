import assert from "node:assert/strict";
import { syncSubscriptions } from "@/lib/billing-sync";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceWindow, calendarWindow } from "@/lib/allowance-window";
import { standingOf } from "@/lib/plan-standing";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sync_observation_flow_only";
const owner = "billing-flow@example.com";
const id = "sub_BillingFlow01";
const cursor = "sub_RetainedCursor01";
const listCursorKey = "nl:billing:sync:after";
let statsId = "";
let list: unknown = { data: [], has_more: false };
let detail: unknown = null;
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET")
    throw new Error("unexpected external operation in synthetic billing flow");
  calls.push(url.pathname);
  if (url.pathname === "/v1/subscriptions") return Response.json(list);
  if (url.pathname === `/v1/subscriptions/${id}`) return Response.json(detail);
  throw new Error("unexpected provider path in synthetic billing flow");
}) as typeof fetch;

async function setup() {
  redis.clear(); calls.length = 0;
  await claimHandle(owner, "billing-flow-shop", "Synthetic billing flow", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_BillingFlow01", subscriptionId: id, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  statsId = store.statsId!;
  assert.ok(store.subscriptionActive && allowanceWindow(store), "fixture has a paid recorded period");
  return store;
}
const row = (status: unknown, rowId = id) => ({ id: rowId, status, customer: "cus_BillingFlow01", metadata: { store: "billing-flow-shop", store_id: statsId } });

async function main() {
  part("Whole-list refusal preserves real stored paid rights and continuation");
  for (const bad of [
    { data: [{ id, metadata: { store: "billing-flow-shop" } }], has_more: false },
    { data: [row(null)], has_more: false },
    { data: [row("future_unknown")], has_more: false },
    { data: [row("canceled"), row(null, "sub_OtherFlow01")], has_more: false },
  ]) {
    const before = await setup();
    await redis.pipeline([["SET", listCursorKey, cursor]]);
    list = bad;
    await assert.rejects(syncSubscriptions(Date.now() + 10000), /complete bounded observation/);
    const after = (await storeForEmail(owner))!;
    is("the actual store is unchanged, including paid period and active status", after, before);
    is("the allowance window derived from the actual store is unchanged", allowanceWindow(after), allowanceWindow(before));
    is("the actual list continuation was not advanced or deleted", await redis.pipeline([["GET", listCursorKey]]), [cursor]);
    is("refusal prevents fallback, writes to Stripe or notifications", calls, ["/v1/subscriptions"]);
  }

  part("Individual fallback observations cannot replace paid rights with unknown data");
  for (const bad of [row("canceled", "sub_AnotherOwner01"), row(null), row("future_unknown")]) {
    const before = await setup();
    list = { data: [], has_more: false }; detail = bad;
    const result = await syncSubscriptions(Date.now() + 10000);
    const after = (await storeForEmail(owner))!;
    is("the real fallback checked the store without writing a false state", [result.checked, result.updated, result.adopted], [1, 0, 0]);
    is("paid store data survives the fallback", after, before);
    is("paid allowance-window data survives the fallback", allowanceWindow(after), allowanceWindow(before));
    is("only the bounded list and exact subscription GET were used", calls, ["/v1/subscriptions", `/v1/subscriptions/${id}`]);
  }

  part("Known cancellation still reconciles rather than being hidden by the guard");
  for (const listed of [true, false]) {
    await setup();
    list = { data: listed ? [row("canceled")] : [], has_more: false };
    detail = row("canceled");
    const result = await syncSubscriptions(Date.now() + 10000);
    const after = (await storeForEmail(owner))!;
    is("the actual synchronizer persists identified cancellation", [result.updated, after.subscriptionActive, after.period], [1, false, null]);
    is("the existing ended-plan retention path is recorded", Number.isFinite(Date.parse(after.planEndedAt)), true);
    const checkedAt = Date.now();
    is("the ended store retains the existing unpaid calendar window", allowanceWindow(after, checkedAt), calendarWindow(checkedAt));
    is("the calendar window does not make the store paid", standingOf(after, checkedAt / 1000) === "paid", false);
    is("the recorded subscription identity stays intact", after.subscriptionId, id);
  }
  done();
}
main();
