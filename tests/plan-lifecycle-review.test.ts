/**
 * The independent pre-review's proofs for claude5/plan-lifecycle-truth, kept
 * as regression checks (G1, A1, M-a, M-b). Each `is` states what must hold.
 *
 * Regra 23, one change to the proofs as received: P2's control read a past-due
 * plan whose invoice has no try scheduled as ended on the day it was read. The
 * same review (M-a) asks that a null `next_payment_attempt` never end a plan on
 * day 0, since 3DS and Billing automations can leave it null while Stripe still
 * has something to do. The control's invoice is now older than Stripe's longest
 * retry window, and a check beside it holds that a fresh one does not end.
 */
import { isPaidUp, startedFrom, stateOf } from "@/lib/billing";
import { syncSubscriptions } from "@/lib/billing-sync";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_prerev_lifecycle";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const period = paidPeriod((NOW - 5 * DAY) * 1000);
const items = { data: [{ id: "si_1", quantity: 1, current_period_start: period.start, current_period_end: period.end, price: { unit_amount: 44900, currency: "usd", lookup_key: "marktmorgen_pro_month", recurring: { interval: "month", interval_count: 1 } } }] };
const base = (over: Record<string, unknown>) => ({ id: "sub_ProofLife1", object: "subscription", status: "active", customer: { id: "cus_ProofLife1", email: "o@example.com" }, metadata: { store: "proof-shop" }, cancel_at_period_end: false, cancel_at: null, trial_end: null, items, ...over });

// ---- fake clock + Stripe for P4
let clock = Date.now();
const realNow = Date.now.bind(Date);
let fake = false;
Date.now = () => (fake ? clock : realNow());
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    if (url.pathname === "/v1/subscriptions") return Response.json({ object: "list", data: [], has_more: false, url: "/v1/subscriptions" });
    const customer = /^\/v1\/customers\/(cus_[A-Za-z0-9]+)$/.exec(url.pathname);
    if (customer) { clock += 1000; return Response.json({ id: customer[1], object: "customer" }); }
    return new Response(JSON.stringify({ error: { code: "resource_missing", message: "No such object" } }), { status: 404 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main() {
  part("P1: a paid plan whose expired switch (pending update) invoice Stripe voided");
  const voidedSwitch = stateOf(base({ latest_invoice: { id: "in_SwitchExpired1", status: "void", billing_reason: "subscription_update", next_payment_attempt: null } }));
  is("the current period was paid: not read as an unpaid renewal", voidedSwitch.state === "active" && !voidedSwitch.renewalUnpaid, true);
  redis.clear();
  await claimHandle("p1@example.com", "p1-shop", "P1", "");
  await ensureStatsId("p1@example.com");
  await setSubscription("p1@example.com", { customerId: "cus_ProofP1", subscriptionId: "sub_ProofLife1", active: true, tier: "pro", cycle: "month", period, renewalUnpaid: voidedSwitch.state === "active" && voidedSwitch.renewalUnpaid });
  is("so its store keeps taking payments", isPaidUp((await storeForEmail("p1@example.com"))!), true);

  part("P2: M1 ends a no-retry plan; the closing day's search (not expanded) reads it live and reopens the store paid up");
  const noRetryExpanded = base({ status: "past_due", latest_invoice: { id: "in_NoRetry1", status: "open", next_payment_attempt: null, collection_method: "charge_automatically", created: NOW - 70 * DAY } });
  is("(control) expanded, it is ended", stateOf(noRetryExpanded).state, "inactive");
  const noRetryFresh = base({ status: "past_due", latest_invoice: { id: "in_NoRetry1", status: "open", next_payment_attempt: null, collection_method: "charge_automatically", created: NOW - DAY } });
  is("(M-a) a fresh invoice with no try scheduled is not an ended plan on day 0", stateOf(noRetryFresh).state, "active");
  const asSearchReturns = base({ status: "past_due" }); // search and the customer list in observeStoreSubscriptions do not expand latest_invoice
  const live = startedFrom(asSearchReturns);
  is("the same subscription unexpanded must not count as a live plan", live, null);
  redis.clear();
  await claimHandle("p2@example.com", "p2-shop", "P2", "");
  await ensureStatsId("p2@example.com");
  await setSubscription("p2@example.com", { customerId: "cus_ProofLife1", subscriptionId: "sub_ProofLife1", active: true, tier: "pro", cycle: "month", period, renewalUnpaid: true });
  await setSubscription("p2@example.com", { active: false }); // M1: the daily job ends it
  if (live) await setSubscription("p2@example.com", { customerId: live.customerId, subscriptionId: live.subscriptionId, active: true, tier: live.tier, cycle: live.cycle, trialEnds: live.trialEnds, shared: live.shared, period: live.period }); // closeOne, lib/plan-closing.ts:903
  is("and its store must not be paid up again while Stripe tries no more", isPaidUp((await storeForEmail("p2@example.com"))!), false);

  part("P3: manual collection (send_invoice): next_payment_attempt is always null");
  const manual = stateOf(base({ status: "past_due", collection_method: "send_invoice", latest_invoice: { id: "in_Manual1", status: "open", collection_method: "send_invoice", next_payment_attempt: null, hosted_invoice_url: "https://invoice.stripe.com/i/x" } }));
  is("an invoice the creator can still pay by link is not a plan that ended", manual.state, "active");

  part("P4: the 404 brake counts per run; runs cut by the deadline end every plan, three at a time");
  redis.clear();
  const owners: string[] = [];
  for (let i = 0; i < 9; i += 1) {
    const owner = `trickle${i}@example.com`;
    await claimHandle(owner, `trickle-shop-${i}`, `T${i}`, "");
    await ensureStatsId(owner);
    await setSubscription(owner, { customerId: `cus_Trickle${i}`, subscriptionId: `sub_Trickle${i}`, active: true, tier: "pro", cycle: "month", period });
    owners.push(owner);
  }
  fake = true;
  for (let run = 0; run < 6; run += 1) { clock += 1; await syncSubscriptions(clock + 2500); }
  fake = false;
  let ended = 0;
  for (const owner of owners) {
    const s = (await storeForEmail(owner))!;
    const queued = (await redis.pipeline([["ZSCORE", ENDED_INDEX, storeRef(s)]]))[0];
    if (!s.subscriptionActive || queued !== null) ended += 1;
  }
  is("nine plans answering 404 at once (an account change) end none, however the runs are cut", ended, 0);
  done();
}
main();
