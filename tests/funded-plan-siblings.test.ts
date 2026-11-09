/**
 * The two other places that read a store's own plan from Stripe read a funded plan as it is (rule 30 siblings of
 * tests/plan-card-funded.test.ts).
 *
 * Every plan is checked out with a funding reference (funding_grant and funding_review on the subscription), and
 * readSubscription without the store answers "unknown" for such a plan. So:
 *
 *   - lib/yearly-offer.ts: a monthly funded plan was never "active", so the yearly offer at a store's first sale was
 *     never sent, and the first sale was noted for good, so it was never sent later either. It only reads, to decide
 *     an email, so it now reads with mode "observe": an activation already committed is confirmed, nothing is
 *     activated or written, and anything unconfirmed still sends nothing.
 *   - lib/plan-closing.ts: on a closing day, a store whose own funded plan runs was "held" ("Stripe could not be
 *     asked") at every daily check, for good. That check puts the store's record right from what Stripe says (it
 *     writes the plan back), the work of the sync; the same function's later look (observeStoreSubscriptions) already
 *     reads a funded plan in mode "activate". So the own read now passes the store, in that same mode: a plan whose
 *     proof is confirmed keeps the store; one that is not stays held, as before, and nothing is removed.
 *
 * The contract proof is a double (tests/contract-activation-billing.ts) that records which proof was asked for; the
 * production Lua is held in tests/plan-card-funded.test.ts and scripts/test_contract_funding_redis.py. Stripe and
 * the email service are fetch doubles; Redis is tests/redis-stub.ts. Synthetic only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { activationObservations, observationReads, switchActivationObservations } from "./contract-activation-billing";
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { offerYearly } from "@/lib/yearly-offer";
import { CLOSING_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS, closeOne, type Hands } from "@/lib/plan-closing";
import { PUBLISHED_PLAN_PRICES } from "@/lib/plan";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_funded_siblings_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
process.env.COMPANY_POSTAL_ADDRESS = "100 Example Street, Example City, NY 10001, United States";

const DAY = 86_400;
const DAY_MS = DAY * 1000;
const emails: { to: string; subject: string }[] = [];
const subscriptions = new Map<string, Record<string, unknown>>();
const stripeWrites: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.hostname === "api.stripe.com") {
    const path = url.pathname.replace(/^\/v1/, "");
    if (method !== "GET") stripeWrites.push(`${method} ${path}`);
    const one = path.match(/^\/subscriptions\/(sub_[A-Za-z0-9]+)$/);
    if (one && subscriptions.has(one[1])) return json(subscriptions.get(one[1]));
    if (path === "/subscriptions/search" || path === "/subscriptions" || path === "/checkout/sessions") return json({ object: "list", data: [], has_more: false });
    return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, subject: body.subject });
    return json({ id: `email-${emails.length}` });
  }
  return new Response(null, { status: 404 });
}) as typeof fetch;

/** A plan bought through the funded checkout, its current period running now. */
function fundedPlan(id: string, handle: string, cycle: "month" | "year"): Record<string, unknown> {
  const created = Math.floor(Date.now() / 1000) - 2 * DAY;
  return {
    id, customer: `cus_${handle}0001`, created, status: "active", cancel_at_period_end: false,
    metadata: { store: handle, funding_grant: `ctr_${handle}grant0000000001`, funding_review: "review-1" },
    items: { data: [{ quantity: 1, current_period_start: created, current_period_end: created + (cycle === "month" ? 30 : 365) * DAY, price: { lookup_key: `nimbus_creator_${cycle}`, unit_amount: PUBLISHED_PLAN_PRICES.creator[cycle], currency: "usd", recurring: { interval: cycle, interval_count: 1 } } }] },
  };
}

function proofs(accept: boolean) {
  activationObservations.calls.length = 0;
  switchActivationObservations.calls.length = 0;
  observationReads.checkout.length = 0;
  observationReads.switches.length = 0;
  activationObservations.accept = accept;
  observationReads.accept = accept;
}

async function storeOnPlan(handle: string, subscriptionId: string) {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle} Studio`, "");
  await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  return email;
}

test.beforeEach(() => {
  redis.clear();
  emails.length = 0;
  stripeWrites.length = 0;
  subscriptions.clear();
});

test("yearly offer: a monthly funded plan whose activation is committed gets the offer, read only", async () => {
  const email = await storeOnPlan("yoko", "sub_yoko0001");
  subscriptions.set("sub_yoko0001", fundedPlan("sub_yoko0001", "yoko", "month"));
  proofs(true);
  const store = (await storeForEmail(email))!;
  assert.equal(await offerYearly(store, true), true, "the offer is sent");
  assert.deepEqual(emails.map((m) => m.to), [email]);
  assert.equal(observationReads.checkout.length, 1, "the committed proof was read once");
  assert.equal(observationReads.checkout[0].subscriptionId, "sub_yoko0001");
  assert.equal(activationObservations.calls.length + switchActivationObservations.calls.length, 0, "nothing was activated");
  assert.deepEqual(stripeWrites, [], "nothing was written at Stripe");
  assert.equal(await offerYearly(store, true), false, "still once per subscription");
  assert.equal(emails.length, 1);
});

test("yearly offer: a funded plan whose proof is not confirmed sends nothing and activates nothing", async () => {
  const email = await storeOnPlan("yuri", "sub_yuri0001");
  subscriptions.set("sub_yuri0001", fundedPlan("sub_yuri0001", "yuri", "month"));
  proofs(false);
  const store = (await storeForEmail(email))!;
  assert.equal(await offerYearly(store, true), false);
  assert.equal(emails.length, 0);
  assert.equal(observationReads.checkout.length, 1, "the read-only proof was asked");
  assert.equal(activationObservations.calls.length + switchActivationObservations.calls.length, 0, "nothing was activated");
  const [mark] = await redis.pipeline([["EXISTS", "nl:yearly-offer:sub_yuri0001"]]);
  assert.equal(mark, 0, "no once-per-subscription mark is spent on an unconfirmed plan");
});

test("yearly offer: a yearly funded plan is never offered the yearly plan", async () => {
  const email = await storeOnPlan("yann", "sub_yann0001");
  subscriptions.set("sub_yann0001", fundedPlan("sub_yann0001", "yann", "year"));
  proofs(true);
  assert.equal(await offerYearly((await storeForEmail(email))!, true), false);
  assert.equal(emails.length, 0);
});

/** Nothing is kept here: every closing step that measures, lists or removes sees an empty store. */
const removed: string[] = [];
const hands: Hands = { measure: async () => 0, pictures: async () => 0, list: async () => [], remove: async (paths) => { removed.push(...paths); } };

/** A store whose plan ended and was told three times, at its closing day; Stripe now says its own funded plan runs. */
async function closingDayOfFunded(handle: string) {
  const subscriptionId = `sub_${handle}0001`;
  const email = await storeOnPlan(handle, subscriptionId);
  await setSubscription(email, { active: false });
  const endedAt = Date.parse((await storeForEmail(email))!.planEndedAt);
  assert.ok(Number.isFinite(endedAt), "the plan ended");
  for (const day of [0, CLOSING_DAYS - WARN_MONTH_DAYS, CLOSING_DAYS - WARN_WEEK_DAYS]) await closeOne(email, endedAt + day * DAY_MS, hands);
  assert.equal(emails.filter((m) => m.to === email).length, 3, "told three times, like anybody");
  subscriptions.set(subscriptionId, fundedPlan(subscriptionId, handle, "month"));
  return { email, endedAt, subscriptionId };
}

test("plan closing: a store whose own funded plan runs, its proof confirmed, is kept and put right", async () => {
  const { email, endedAt, subscriptionId } = await closingDayOfFunded("kira");
  proofs(true);
  removed.length = 0;
  const day = await closeOne(email, endedAt + CLOSING_DAYS * DAY_MS, hands);
  assert.deepEqual([day.state, day.note], ["running", "Stripe says the plan runs"]);
  const now = (await storeForEmail(email))!;
  assert.deepEqual([now.subscriptionActive, now.subscriptionId, now.planEndedAt], [true, subscriptionId, ""]);
  assert.equal(activationObservations.calls.length >= 1, true, "the plan's proof was asked in the sync's mode");
  assert.equal(activationObservations.calls.every((call) => call.subscriptionId === subscriptionId), true);
  assert.deepEqual(removed, [], "nothing is removed");
});

test("plan closing: a store whose own funded plan is not confirmed stays held, and nothing is removed", async () => {
  const { email, endedAt } = await closingDayOfFunded("kurt");
  proofs(false);
  removed.length = 0;
  const day = await closeOne(email, endedAt + CLOSING_DAYS * DAY_MS, hands);
  assert.deepEqual([day.state, day.coverage], ["held", "unknown"]);
  assert.equal(activationObservations.calls.length >= 1, true, "the proof was asked, and it did not confirm");
  assert.deepEqual(removed, [], "nothing is removed");
  assert.deepEqual(stripeWrites, [], "nothing was ended at Stripe");
});
