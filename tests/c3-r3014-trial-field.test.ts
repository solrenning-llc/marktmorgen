/**
 * Claude 3, focal return on #3014 (d199dd13): a row whose trial_end is MISSING is read
 * as "no trial", the direction that owes. Adapted from pt2-tier-benefits-trial-unpaid.
 * Original: 422 [PT2], unit 1: a membership whose free trial ended and whose FIRST
 * charge failed is "past_due" on Stripe (and "unpaid" once the retries run
 * out). Nothing was ever paid for it, so the one-time benefit is not owed
 * until a payment is known (the membership is active again). A past_due
 * membership that never had a trial did pay its first charge, and stays
 * owed. Found by Claude 1's independent review of #3014 (its proof
 * c1proof-tben-trial-pastdue, kept here as a permanent test).
 */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { owedNow } from "@/lib/tier-benefit-rules";
import { addBenefit, benefitsDue } from "@/lib/tier-benefits";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_benefits_only";

const DAY = 86_400;
const TRIAL_START = Date.UTC(2027, 0, 1, 9) / 1000;
const TRIAL_END = TRIAL_START + 14 * DAY; // billing_cycle_anchor = the end of the free trial
const NOW = TRIAL_END + 2 * DAY; // two days after the first charge after the trial failed

const once = { id: "b000000000001", product: "p1", text: "A signed print", cadence: "once" as const, since: TRIAL_START - DAY, retired: 0 };
const member = { sub: "sub_trialfailed1", status: "past_due", product: "p1", anchor: TRIAL_END, start: TRIAL_START, trialEnd: TRIAL_END, paused: false };

let basicId = "";
const sub = (id: string, email: string, extra: Record<string, unknown>) => ({
  id,
  status: "active",
  start_date: TRIAL_START,
  billing_cycle_anchor: TRIAL_START,
  trial_end: null,
  metadata: { store: "trialstore", product: basicId },
  customer: { id: `cus_${id.slice(4)}`, email },
  items: { data: [{ price: { unit_amount: 1000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } }, current_period_end: NOW + 10 * DAY }] },
  ...extra,
});

globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === "/subscriptions") {
    return answer({ object: "list", has_more: false, data: [
      // Trial ended, first charge failed: never paid.
      // The same never-paid trial, with the row's trial_end missing (a reply in another shape: Stripe always sends it).
      (() => { const row: Record<string, unknown> = sub("sub_trialgone001", "ivy@example.com", { status: "past_due", billing_cycle_anchor: TRIAL_END }); delete row.trial_end; return row; })(),
      // Control: no trial, a renewal being retried, trial_end null as Stripe sends it: owed.
      sub("sub_nottrial0001", "lou@example.com", { status: "past_due" }),
    ] });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "trials@example.com";
  await claimHandle(owner, "trialstore", "Trial Store", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1Trialxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_Owner00003", subscriptionId: "sub_Owner00003", active: true, period: paidPeriod() });
  const basic = await addProduct(owner, "Basic", "", "10", { interval: "month" as const, trialDays: 14, payments: 0 });
  if (!basic.ok) throw new Error("no product");
  basicId = basic.product.id;
  const store = (await storeForEmail(owner))!;
  const print = await addBenefit(store, { product: basicId, text: "A signed print", cadence: "once" }, (TRIAL_START - DAY) * 1000);
  if (!print.ok) throw new Error("no benefit");
  const due = await benefitsDue(store, NOW * 1000);
  part("A row with no trial_end field");
  is("control: the member with trial_end null and no trial is owed", due.state === "ok" && due.rows.some((r) => r.sub === "sub_nottrial0001"), true);
  is("the row missing trial_end is not owed the one-time benefit", due.state === "ok" && due.rows.some((r) => r.sub === "sub_trialgone001"), false);
  console.log("due:", JSON.stringify(due).slice(0, 400));
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
