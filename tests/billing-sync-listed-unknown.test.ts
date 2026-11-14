/**
 * The daily subscription sync (lib/billing-sync.ts), step 1: a listed row of
 * the store's own subscription whose plan cannot be read (stateOf "unknown",
 * CX-123 rule 24) is not "the store is in line with Stripe".
 *
 * Before: applyListed answered true for it, so the subscription went into
 * `seen`, step 2 never asked Stripe about the store on its own, nothing was
 * counted as failed, and the run said it was complete and healthy. A renewal
 * Stripe could not collect (past_due) was then never written down, and what
 * costs us to run kept going for a creator who had not paid (232 [CA1] unit 4).
 * Synthetic data only; no write is ever sent to Stripe.
 */
import { syncSubscriptions } from "@/lib/billing-sync";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { PLAN_PRICES } from "@/lib/plan";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sync_listed_unknown_only";
const owner = "billing-listed-unknown@example.com";
const handle = "billing-listed-unknown";
const id = "sub_ListedUnknown01";
const calls: string[] = [];
let list: unknown = { data: [], has_more: false };
let detail: unknown = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || init?.method !== "GET") throw new Error("unexpected external operation in synthetic billing sync");
  calls.push(url.pathname);
  if (url.pathname === "/v1/subscriptions") return Response.json(list);
  if (url.pathname === `/v1/subscriptions/${id}`) return Response.json(detail);
  throw new Error("unexpected provider path in synthetic billing sync");
}) as typeof fetch;

/** A full creator monthly reply, renewal unpaid and Stripe still retrying (past_due, in grace). */
function pastDue(period: { start: number; end: number }) {
  return {
    id,
    object: "subscription",
    status: "past_due",
    customer: "cus_ListedUnknown01",
    metadata: { store: handle },
    trial_end: null,
    cancel_at: null,
    cancel_at_period_end: false,
    pending_update: null,
    items: {
      object: "list",
      has_more: false,
      data: [{
        id: "si_ListedUnknown01",
        quantity: 1,
        current_period_start: period.start,
        current_period_end: period.end,
        price: { id: "price_ListedUnknown01", currency: "usd", unit_amount: PLAN_PRICES.creator.month, lookup_key: "nimbus_creator_month", recurring: { interval: "month", interval_count: 1 } },
      }],
    },
  };
}

async function main() {
  const period = paidPeriod();
  redis.clear();
  await claimHandle(owner, handle, "Synthetic listed unknown", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_ListedUnknown01", subscriptionId: id, active: true, tier: "creator", cycle: "month", period });
  const before = (await storeForEmail(owner))!;
  if (!before.subscriptionActive || before.renewalUnpaidSince) throw new Error("fixture store is not paid up");

  part("Control: the full past_due reply, read on its own, writes the unpaid renewal down");
  {
    const full = pastDue(period);
    detail = full;
    list = { data: [full], has_more: false };
    const result = await syncSubscriptions(Date.now() + 10_000);
    const after = (await storeForEmail(owner))!;
    is("applied in step 1, nothing failed", [result.updated, result.failed], [1, 0]);
    is("the unpaid renewal is written down", (after.renewalUnpaidSince ?? 0) > 0, true);
    await setSubscription(owner, { active: true, renewalUnpaid: false, period });
  }

  part("A listed row without its plan line is unknown: step 2 asks about the store, or the run is a failed one");
  {
    calls.length = 0;
    const full = pastDue(period);
    const { items: _items, ...withoutPlan } = full;
    void _items;
    list = { data: [withoutPlan], has_more: false };
    detail = full;
    await syncSubscriptions(Date.now() + 10_000);
    const after = (await storeForEmail(owner))!;
    is("step 2 read the store's own subscription by its exact id", calls, ["/v1/subscriptions", `/v1/subscriptions/${id}`]);
    is("the unpaid renewal Stripe reports is written down in the same run", (after.renewalUnpaidSince ?? 0) > 0, true);
  }

  part("A listed row without its plan line, and the store's own read unknown too: counted as a failure, never complete");
  {
    calls.length = 0;
    const full = pastDue(period);
    const { items: _items, ...withoutPlan } = full;
    void _items;
    list = { data: [withoutPlan], has_more: false };
    detail = withoutPlan;
    const result = await syncSubscriptions(Date.now() + 10_000);
    is("an unknown reading is a failure, not a store in line", result.failed >= 1, true);
  }
  done();
}
main();
