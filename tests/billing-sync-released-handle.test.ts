/**
 * A store that changed its address, and then let the old one go, keeps its
 * own plan in line with Stripe (audit of store handles, finding 3).
 *
 * Renaming does not rewrite a plan's metadata in Stripe: the plan stays under
 * the address it was bought with. An address let go answers nothing for a
 * month (storeForHandle is null) and may then belong to another creator. So
 * the store that keeps a subscription is never found by that name alone:
 *
 *   - an unpaid renewal is written down on the store that keeps it before
 *     its email says what has stopped;
 *   - the other way round, the store that holds the old name now, or a
 *     customer that is not the store's own, is never written to.
 *
 * (The daily job's step 1 has the same gap for a canceled plan; its step 2
 * asks about such a store on its own once step 1 no longer marks as seen
 * what it could not apply, which is #3216's change to lib/billing-sync.ts.)
 */
import { recordUnpaidRenewal } from "@/lib/billing-sync";
import { claimHandle, ensureStatsId, releaseHandle, renameHandle, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_released_handle_only";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const owner = "released-plan@example.com";
const other = "new-holder@example.com";
const OLD = "old-plan-shop";
const SUB = "sub_ReleasedPlan01";
const CUSTOMER = "cus_ReleasedPlan01";

let listed: Record<string, unknown>[] = [];
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.origin !== "https://api.stripe.com" || method !== "GET") throw new Error(`unexpected external operation: ${method} ${url}`);
  asked.push(url.pathname);
  if (url.pathname === "/v1/subscriptions") return Response.json({ object: "list", data: listed, has_more: false });
  const one = listed.find((row) => url.pathname === `/v1/subscriptions/${row.id}`);
  if (one) return Response.json(one);
  return Response.json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

function plan(status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const period = paidPeriod(NOW * 1_000);
  return {
    id: SUB,
    status,
    created: NOW - 90 * DAY,
    metadata: { store: OLD },
    customer: { id: CUSTOMER, email: owner },
    items: { data: [{ current_period_start: period.start, current_period_end: period.end, price: { lookup_key: "nimbus_labs_pro_month", unit_amount: 44900, recurring: { interval: "month" } } }] },
    latest_invoice: { id: "in_ReleasedPlan01", status: "open", amount_due: 44900, hosted_invoice_url: "https://invoice.stripe.com/i/acct_x/test_unpaid", next_payment_attempt: NOW + 3 * DAY },
    ...over,
  };
}

/** The store bought its plan under OLD, moved to a new address, and (when asked) let OLD go; (when asked) another creator holds OLD now. */
async function setup(release: boolean, reclaimed = false) {
  redis.clear();
  asked.length = 0;
  await claimHandle(owner, OLD, "Synthetic plan store", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: CUSTOMER, subscriptionId: SUB, active: true, tier: "pro", cycle: "month", period: paidPeriod(NOW * 1_000) });
  is("setup: renamed", (await renameHandle(owner, "new-plan-shop")).ok, true);
  if (release) is("setup: old address let go", (await releaseHandle(owner, OLD)).ok, true);
  if (reclaimed) {
    // The month of quarantine is over and another creator takes the name.
    await redis.pipeline([["DEL", `nl:store:handle:${OLD}`]]);
    is("setup: another creator holds the old address", (await claimHandle(other, OLD, "Someone else", "")).ok, true);
    await ensureStatsId(other);
  }
}

async function main() {
  part("an unpaid renewal is written down on the store that keeps it");
  for (const [label, release, reclaimed] of [["renamed only", false, false], ["renamed and let go", true, false], ["let go and taken by another creator", true, true]] as const) {
    await setup(release, reclaimed);
    is(`${label}: recorded`, await recordUnpaidRenewal(plan("past_due")), true);
    is(`${label}: the store keeps the date`, ((await storeForEmail(owner))!.renewalUnpaidSince ?? 0) > 0, true);
    if (reclaimed) is(`${label}: the new holder of the name is not touched`, ((await storeForEmail(other))?.renewalUnpaidSince ?? 0) > 0, false);
  }

  part("the other way round: never by the name alone");
  {
    await setup(true);
    // Under a released address, only this store's own customer counts, never its email address.
    is("released address, another customer with the owner's email: not this store's", await recordUnpaidRenewal(plan("past_due", { customer: { id: "cus_Foreign00001", email: owner } })), null);
    is("released address, another subscription id: not this store's", await recordUnpaidRenewal(plan("past_due", { id: "sub_NotThisStore01" })), null);
    is("nothing was written", ((await storeForEmail(owner))!.renewalUnpaidSince ?? 0) > 0, false);
    is("an add-on is not a plan", await recordUnpaidRenewal(plan("past_due", { metadata: { store: OLD, addon: "assistant" } })), null);
    is("no customer address to look by: nothing found, nothing written", await recordUnpaidRenewal(plan("past_due", { customer: CUSTOMER })), null);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
