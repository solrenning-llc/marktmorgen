/**
 * The daily subscription sync (lib/billing-sync.ts): a subscription counts as
 * seen by step 1 only after its state was applied, and step 2 always runs.
 *
 * Before: step 1 put a subscription in `seen` before applying it, so when
 * applying failed, step 2 skipped its store and a store that stopped paying
 * kept selling until the next full lap of the list; and a list page Stripe
 * answered with one unreadable row threw out of the whole sync, so step 2 never
 * ran at all. Synthetic data only; no write is ever sent to Stripe.
 */
import { syncSubscriptions } from "@/lib/billing-sync";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sync_seen_after_apply_only";
const owner = "billing-seen@example.com";
const handle = "billing-seen-shop";
const id = "sub_BillingSeen01";
const cursor = "sub_SeenCursor01";
const listCursorKey = "nl:billing:sync:after";
let list: unknown = { data: [], has_more: false };
let detail: unknown = null;
/** Set when the list page was answered: the next Redis call after it fails once. */
let failNextAfterList = false;
let armed = false;
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET") throw new Error("unexpected external operation in synthetic billing sync");
  calls.push(url.pathname);
  if (url.pathname === "/v1/subscriptions") {
    if (armed) failNextAfterList = true;
    return Response.json(list);
  }
  if (url.pathname === `/v1/subscriptions/${id}`) return Response.json(detail);
  throw new Error("unexpected provider path in synthetic billing sync");
}) as typeof fetch;

const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (failNextAfterList) {
    failNextAfterList = false;
    throw new Error("synthetic Redis failure while applying a listed subscription");
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const row = (status: unknown, rowId = id) => ({ id: rowId, object: "subscription", status, metadata: { store: handle }, items: { data: [] } });

async function setup() {
  redis.clear(); calls.length = 0; armed = false; failNextAfterList = false;
  await claimHandle(owner, handle, "Synthetic billing seen", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_BillingSeen01", subscriptionId: id, active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  if (!store.subscriptionActive) throw new Error("fixture store is not paid up");
  return store;
}

async function main() {
  part("Healthy control: a listed cancellation is applied in step 1 and counted as seen");
  {
    await setup();
    list = { data: [row("canceled")], has_more: false }; detail = row("canceled");
    const result = await syncSubscriptions(Date.now() + 10_000);
    const after = (await storeForEmail(owner))!;
    is("applied once, nothing failed, both steps complete", [result.updated, result.failed, result.checked, result.complete], [1, 0, 0, true]);
    is("the store stopped counting as paid up", after.subscriptionActive, false);
    is("step 2 did not ask about a subscription step 1 settled", calls, ["/v1/subscriptions"]);
  }

  part("A listed subscription whose apply failed is asked about again by step 2, in the same run");
  {
    await setup();
    list = { data: [row("canceled")], has_more: false }; detail = row("canceled");
    armed = true;
    let result: Awaited<ReturnType<typeof syncSubscriptions>> | string;
    try { result = await syncSubscriptions(Date.now() + 10_000); } catch (error) { result = `threw: ${(error as Error).message}`; }
    armed = false;
    const after = (await storeForEmail(owner))!;
    is("the failed apply is counted, and step 2 checked the store on its own", typeof result === "string" ? result : [result.failed, result.checked, result.updated], [1, 1, 1]);
    is("the store that stopped paying no longer counts as paid up", after.subscriptionActive, false);
    is("step 2 read the store's own subscription by its exact id", calls, ["/v1/subscriptions", `/v1/subscriptions/${id}`]);
  }

  part("A list page refused as a whole: step 2 still runs, the page is retried, and the run is not complete");
  for (const bad of [
    { data: [{ id, metadata: { store: handle } }], has_more: false },
    { data: [row("future_unknown")], has_more: false },
    { data: [row("canceled"), row(null, "sub_OtherSeen01")], has_more: false },
  ]) {
    await setup();
    await redis.pipeline([["SET", listCursorKey, cursor]]);
    list = bad; detail = row("canceled");
    let result: Awaited<ReturnType<typeof syncSubscriptions>> | string;
    try { result = await syncSubscriptions(Date.now() + 10_000); } catch (error) { result = `threw: ${(error as Error).message}`; }
    const after = (await storeForEmail(owner))!;
    is("the sync answers with the refusal counted and the run incomplete", typeof result === "string" ? result : [result.failed >= 1, result.complete, result.checked], [true, false, 1]);
    is("the known cancellation read on its own is applied by step 2", after.subscriptionActive, false);
    is("the list continuation still points at the refused page", await redis.pipeline([["GET", listCursorKey]]), [cursor]);
    is("only reads were sent to Stripe", calls, ["/v1/subscriptions", `/v1/subscriptions/${id}`]);
  }

  part("A refused page and an unreadable individual answer: nothing about the store changes");
  {
    const before = await setup();
    list = { data: [row(null)], has_more: false }; detail = row(null);
    let result: Awaited<ReturnType<typeof syncSubscriptions>> | string;
    try { result = await syncSubscriptions(Date.now() + 10_000); } catch (error) { result = `threw: ${(error as Error).message}`; }
    const after = (await storeForEmail(owner))!;
    is("counted as failed and incomplete, the store checked and not updated", typeof result === "string" ? result : [result.failed >= 1, result.complete, result.checked, result.updated], [true, false, 1, 0]);
    is("an unreadable row is neither paying nor not paying: the store is unchanged", after, before);
  }
  done();
}
main();
