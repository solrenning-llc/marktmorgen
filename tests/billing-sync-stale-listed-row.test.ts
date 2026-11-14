/**
 * The daily subscription sync (lib/billing-sync.ts, applyListed) reads a page
 * of up to 100 subscriptions, then applies its rows one at a time; each row
 * before can take Stripe calls of its own, so a row can be seconds or minutes
 * old when its store is read. A row of the store's own subscription that is
 * older than what the store wrote down since (the plan ended by the
 * money-back refund or the cancel button, or moved to another plan) must
 * never be written over it: no plan given back after it ended, its closing
 * clock not restarted, no paid plan taken down to the one before a switch.
 * A change the listed row would make is written only from a fresh read of
 * that one subscription. Synthetic data only; no write is ever sent to Stripe.
 */
import { syncSubscriptions } from "@/lib/billing-sync";
import { PLAN_PRICES } from "@/lib/plan";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sync_stale_listed_row";
const owner = "billing-stale-row@example.com";
const handle = "billing-stale-row";
const id = "sub_BillingStale01";
const customer = "cus_BillingStale01";

type Row = Record<string, unknown>;
const period = paidPeriod();
function row(status: string, tier: "creator" | "pro" | "scale" = "pro", over: Row = {}): Row {
  return {
    id, object: "subscription", status, customer, created: period.start,
    metadata: { store: handle }, cancel_at: null, cancel_at_period_end: false, pending_update: null,
    items: { object: "list", has_more: false, data: [{
      id: "si_BillingStale01", quantity: 1, current_period_start: period.start, current_period_end: period.end,
      price: { id: `price_Stale${tier}01`, currency: "usd", unit_amount: PLAN_PRICES[tier].month, lookup_key: `nimbus_${tier}_month`, recurring: { interval: "month", interval_count: 1 } },
    }] },
    ...over,
  };
}

let listed: Row = row("active");
let detail: Row = row("active");
/** Runs once, while Stripe is answering the list: the store changes after the page was read. */
let duringList: (() => Promise<void>) | null = null;
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || (init?.method ?? "GET") !== "GET") throw new Error("unexpected external operation in synthetic billing sync");
  calls.push(url.pathname);
  if (url.pathname === "/v1/subscriptions") {
    const page = { object: "list", data: [listed], has_more: false };
    const change = duringList;
    duringList = null;
    if (change) await change();
    return Response.json(page);
  }
  if (url.pathname === `/v1/subscriptions/${id}`) return Response.json(detail);
  throw new Error(`unexpected provider path in synthetic billing sync: ${url.pathname}`);
}) as typeof fetch;

async function setup(tier: "creator" | "pro" | "scale" = "pro") {
  redis.clear(); calls.length = 0; duringList = null;
  await claimHandle(owner, handle, "Synthetic stale row", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: customer, subscriptionId: id, active: true, tier, cycle: "month", period });
  const store = (await storeForEmail(owner))!;
  if (!store.subscriptionActive || store.tier !== tier) throw new Error("fixture store is not paid up");
  return store;
}

async function main() {
  part("A plan ended after the list page was read is not given back by that page's old row");
  {
    await setup();
    listed = row("active");
    detail = row("canceled");
    let endedAt = "";
    duringList = async () => {
      // The money-back refund (lib/plan-refund-flow.ts endPlanNow) or the cancel button: Stripe ended it, the store wrote it down.
      await setSubscription(owner, { active: false, period: null });
      endedAt = (await storeForEmail(owner))!.planEndedAt;
    };
    await syncSubscriptions(Date.now() + 10_000);
    const after = (await storeForEmail(owner))!;
    is("the ended plan stays ended", after.subscriptionActive, false);
    is("its closing clock is not restarted", [after.planEndedAt !== "", after.planEndedAt === endedAt], [true, true]);
    is("the change was checked against the subscription itself", calls.includes(`/v1/subscriptions/${id}`), true);
  }

  part("A switch written after the list page was read is not taken back to the plan before it");
  {
    await setup("pro");
    listed = row("active", "pro");
    detail = row("active", "scale");
    duringList = async () => { await setSubscription(owner, { active: true, tier: "scale", cycle: "month", period }); };
    await syncSubscriptions(Date.now() + 10_000);
    const after = (await storeForEmail(owner))!;
    is("the store keeps the plan it now pays for", [after.subscriptionActive, after.tier], [true, "scale"]);
  }

  part("A fresh read Stripe cannot give changes nothing");
  {
    const before = await setup();
    listed = row("canceled");
    detail = { error: "synthetic unreadable answer" };
    await syncSubscriptions(Date.now() + 10_000);
    const after = (await storeForEmail(owner))!;
    is("an unreadable fresh read leaves the store as it was", [after.subscriptionActive, after.tier, after.planEndedAt], [before.subscriptionActive, before.tier, before.planEndedAt]);
  }

  part("Healthy controls: a row that agrees with Stripe is still applied");
  {
    await setup();
    listed = row("canceled");
    detail = row("canceled");
    const result = await syncSubscriptions(Date.now() + 10_000);
    const after = (await storeForEmail(owner))!;
    is("a real cancellation ends the plan in the same run", [after.subscriptionActive, after.planEndedAt !== "", result.failed], [false, true, 0]);
  }
  {
    await setup("pro");
    listed = row("active", "scale");
    detail = row("active", "scale");
    await syncSubscriptions(Date.now() + 10_000);
    const after = (await storeForEmail(owner))!;
    is("a real switch made at Stripe is written down", [after.subscriptionActive, after.tier], [true, "scale"]);
  }
  {
    await setup("pro");
    listed = row("active", "pro");
    detail = row("active", "pro");
    await syncSubscriptions(Date.now() + 10_000);
    is("a row that changes nothing asks Stripe nothing more", calls, ["/v1/subscriptions"]);
  }
  done();
}
main();
