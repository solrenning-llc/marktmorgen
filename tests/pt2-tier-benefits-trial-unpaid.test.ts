/**
 * 422 [PT2], unit 1: a membership whose free trial ended and whose FIRST
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
      sub("sub_trialdue0001", "ivy@example.com", { status: "past_due", billing_cycle_anchor: TRIAL_END, trial_end: TRIAL_END }),
      sub("sub_trialunp0001", "jon@example.com", { status: "unpaid", billing_cycle_anchor: TRIAL_END, trial_end: TRIAL_END }),
      // Trial ended and was paid: owed.
      sub("sub_trialpaid001", "kim@example.com", { status: "active", billing_cycle_anchor: TRIAL_END, trial_end: TRIAL_END }),
      // No trial: the first charge went through, a renewal is being retried: owed.
      sub("sub_nottrial0001", "lou@example.com", { status: "past_due" }),
    ] });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  part("Trial ended, first charge failed: nothing was ever paid");
  is("past_due right after the trial: the one-time benefit is not owed", owedNow(once, member, NOW), { owed: false, why: "unpaid" });
  is("unpaid (retries exhausted) right after the trial: not owed either", owedNow(once, { ...member, status: "unpaid" }, NOW + 20 * DAY), { owed: false, why: "unpaid" });
  is("the trial ended and was paid (active): owed", owedNow(once, { ...member, status: "active" }, NOW).owed, true);
  is("no trial, a renewal being retried: the first payment went through, still owed", owedNow(once, { ...member, trialEnd: 0, anchor: TRIAL_START }, NOW).owed, true);

  part("Read from the creator's Stripe: the trial's end is read, and the members who never paid wait");
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
  if (due.state !== "ok") throw new Error(`benefits not read: ${JSON.stringify(due)}`);
  is("owed: only the member who paid after the trial and the one without a trial", due.rows.map((r) => r.sub).sort(), ["sub_nottrial0001", "sub_trialpaid001"]);
  is("the two who never paid are counted as waiting for a payment", due.waiting[print.benefit.id], { trial: 0, unpaid: 2, paused: 0 });
  is("every membership was read", [due.complete, due.unreadable], [true, 0]);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
