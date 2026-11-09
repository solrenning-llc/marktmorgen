/**
 * A plan subscription whose collection is paused (`pause_collection`, which
 * only Stripe's dashboard sets: this code never does, lib/plan-pause.ts) is
 * still "active" at Stripe, and was read as a plan paid for: the store sold
 * and spent its full allowances with nothing collected (plan-lifecycle audit,
 * finding L4). It is now read as a renewal unpaid: the plan runs and nothing
 * closes, but what costs us to run is paused, as for any period not paid.
 */
import { stateOf } from "@/lib/billing";
import { costStandingOf } from "@/lib/plan-standing";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
const period = paidPeriod(NOW * 1000);
const subscription = (pause: unknown) => ({
  id: "sub_PauseCollection1", status: "active", cancel_at_period_end: false, cancel_at: null,
  pause_collection: pause,
  items: { data: [{ id: "si_1", quantity: 1, current_period_start: period.start, current_period_end: period.end, price: { unit_amount: 99900, currency: "usd", lookup_key: "marktmorgen_scale_month", recurring: { interval: "month", interval_count: 1 } } }] },
});

part("collection paused at Stripe");
for (const behavior of ["void", "keep_as_draft", "mark_uncollectible"]) {
  const read = stateOf(subscription({ behavior, resumes_at: null }));
  is(`paused (${behavior}): the plan runs`, read.state, "active");
  is(`paused (${behavior}): but it is not paid for, so what costs us is paused`, read.state === "active" && read.renewalUnpaid, true);
  const record = { subscriptionActive: true, subscriptionId: "sub_PauseCollection1", trialEnds: 0, planEndedAt: "", renewalUnpaidSince: read.state === "active" && read.renewalUnpaid ? NOW : 0 };
  is(`paused (${behavior}): the store gets what a store with no plan gets for costs`, costStandingOf(record, NOW), "ended");
}

part("collection not paused");
const plain = stateOf(subscription(null));
is("a plan with nothing paused is paid for", plain.state === "active" && !plain.renewalUnpaid, true);
done();
