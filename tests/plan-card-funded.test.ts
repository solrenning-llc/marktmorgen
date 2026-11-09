/**
 * The studio's plan card reads a funded subscription without writing anything.
 *
 * Every new plan is checked out with a funding reference (app/api/billing/checkout
 * reserves the contract first, so the subscription carries funding_grant and
 * funding_review). readSubscription without a store reads such a plan as
 * "unknown", so the card would say "could not confirm" to every paying creator
 * for good and the notice before a trial ends would never show. Reading it with
 * the store goes through activateCheckoutContract, which may write the
 * activation on any studio load. The studio now reads it with mode "observe":
 * the same proof, read only. An activation the return path, the webhook or the
 * daily sync already committed is shown with its amount and date; anything else
 * stays "unknown" (the card's "could not confirm"), and neither Redis nor Stripe
 * is written.
 *
 * Synthetic only: the ledger is tests/contract-funding-redis.ts (CI runs the
 * production Lua against real Redis in scripts/test_contract_funding_redis.py),
 * Stripe is a fetch double.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readSubscription } from "@/lib/billing";
import * as funding from "@/lib/contract-funding";
import { activateCheckoutContract, reserveContractFunding } from "@/lib/contract-funding";
import { contractFundingConfiguration } from "@/lib/contract-funding-rules";
import { setContractFundingPolicy } from "./contract-funding-approved-policy";
import { setContractFinancialReview } from "./contract-commercial-context";
import { contractFixture } from "./contract-funding-fixture";
import { calls, ledger, reset, seed } from "./contract-funding-redis";
import { planAmountWords, planDueSoon } from "@/components/renewal-unpaid-notice";
import { PUBLISHED_PLAN_PRICES } from "@/lib/plan";
import type { Store } from "@/lib/store";

process.env.STRIPE_SECRET_KEY = "sk_test_not_a_real_deployment_key";
const DAY = 86_400;
const store = {
  statsId: "card-funded", handle: "harbor", email: "owner@example.test", stripeCustomerId: "cus_Test000001",
  subscriptionId: "sub_Test000001", previousHandles: [], releasedHandles: [], extra: false,
} as unknown as Store;
const page = readFileSync("app/studio/page.tsx", "utf8");
const parts = funding as unknown as Record<string, unknown>;
const snapshot = () => JSON.stringify([...ledger].map(([key, value]) => [key, [...value].sort()]));
const read = (mode: string) => (readSubscription as unknown as (id: string, s: Store, m: string) => ReturnType<typeof readSubscription>)(store.subscriptionId!, store, mode);
/** Every Lua script sent to Redis, and whether it can write. */
const scripts = () => calls.flat().filter((c) => c[0] === "EVAL").map((c) => String(c[1]));
const writes = (script: string) => /redis\.call\('(HSET|HDEL|SET|DEL|HINCRBY|INCR|INCRBY|EXPIRE|ZADD|ZREM|SADD|SREM|LPUSH|RPUSH)'/.test(script);

function start() {
  reset();
  const f = contractFixture();
  setContractFinancialReview(f.review);
  setContractFundingPolicy(f.policy);
  seed(contractFundingConfiguration(f.policy, f.context)!);
  return f;
}

type World = { stripe: number; stripeWrites: number };
function stripe(subscription: Record<string, unknown>): World {
  const world = { stripe: 0, stripeWrites: 0 };
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    world.stripe++;
    if ((init?.method ?? "GET") !== "GET") world.stripeWrites++;
    return Response.json(subscription);
  }) as typeof fetch;
  return world;
}

/** A plan bought through the funded checkout, just now: monthly paid, or a yearly trial ending in three days. */
async function funded(kind: "paid" | "trial") {
  const cycle = kind === "paid" ? "month" : "year";
  const grant = await reserveContractFunding(store.statsId!, "creator", cycle, "checkout");
  assert.ok(grant, "the synthetic ledger funds a checkout");
  const created = Math.floor(Date.now() / 1000);
  const end = kind === "paid" ? created + 30 * DAY : created + 3 * DAY;
  const amount = PUBLISHED_PLAN_PRICES.creator[cycle];
  const subscription: Record<string, unknown> = {
    id: store.subscriptionId, customer: store.stripeCustomerId, created, status: kind === "paid" ? "active" : "trialing",
    ...(kind === "trial" ? { trial_start: created, trial_end: end } : {}),
    metadata: { store: store.handle, funding_grant: grant.id, funding_review: grant.reviewId },
    items: { data: [{ quantity: 1, current_period_start: created, current_period_end: kind === "paid" ? end : created + 365 * DAY, price: { lookup_key: `nimbus_creator_${cycle}`, unit_amount: amount, currency: "usd", recurring: { interval: cycle, interval_count: 1 } } }] },
  };
  const activation = {
    statsId: store.statsId!, grantId: grant.id, reviewId: grant.reviewId, subscriptionId: store.subscriptionId!,
    tier: "creator" as const, cycle: cycle as "month" | "year", createdSeconds: created, trialing: kind === "trial",
    periodStartSeconds: created, periodEndSeconds: end,
  };
  return { subscription, activation, end, amount, cycle };
}

const old = globalThis.fetch;
test.after(() => { globalThis.fetch = old; });

test("the studio reads its plan with the store, in the read-only mode, still once per load", () => {
  assert.equal(page.includes('early(readSubscription(store.subscriptionId, store, "observe"))'), true);
  assert.equal(page.split("readSubscription(").length - 1, 1);
});

test("the read-only scripts are the activation proofs cut before any write", () => {
  for (const [observe, activate] of [["OBSERVE_CONTRACT", "ACTIVATE_CONTRACT"], ["OBSERVE_SWITCH_CONTRACT", "ACTIVATE_SWITCH_CONTRACT"]]) {
    const script = parts[observe], original = parts[activate];
    assert.equal(typeof script, "string", `${observe} exists`);
    const text = String(script);
    assert.equal(writes(text), false, `${observe} cannot write`);
    assert.deepEqual([...new Set(text.match(/redis\.call\('([A-Z]+)'/g))].sort(), ["redis.call('HGET'", "redis.call('TTL'", "redis.call('TYPE'"], `${observe} only reads`);
    assert.equal(String(original).startsWith(text.slice(0, text.lastIndexOf("return 0"))), true, `${observe} keeps every check of ${activate}`);
    assert.equal(text.trimEnd().endsWith("return 0"), true, `${observe} answers 0 where ${activate} would activate`);
  }
});

test("a funded plan already activated shows its amount and its next charge; nothing is written", async () => {
  start();
  const { subscription, activation, end, amount } = await funded("paid");
  assert.equal(await activateCheckoutContract(activation), true, "the return path or the sync activated it earlier");
  const before = snapshot();
  calls.length = 0;
  const world = stripe(subscription);
  const live = await read("observe");
  assert.equal(live.state, "active");
  assert.equal(live.state === "active" && planAmountWords(live.amountCents, live.cycle), `$${amount / 100} a month`);
  assert.equal(live.state === "active" && live.until, end);
  assert.equal(live.state === "active" && live.period?.funded, true);
  assert.equal(snapshot(), before, "the ledger is unchanged");
  assert.deepEqual(scripts().map(writes), [false], "one read-only script, no write");
  assert.deepEqual(world, { stripe: 1, stripeWrites: 0 });
});

test("a funded trial ending in three days brings the notice, with no write", async () => {
  start();
  const { subscription, activation, end, amount } = await funded("trial");
  assert.equal(await activateCheckoutContract(activation), true);
  const before = snapshot();
  calls.length = 0;
  const world = stripe(subscription);
  const live = await read("observe");
  assert.deepEqual(planDueSoon(live, Math.floor(Date.now() / 1000)), { kind: "trial", at: end, amountCents: amount, cycle: "year" });
  assert.equal(snapshot(), before);
  assert.deepEqual(scripts().map(writes), [false]);
  assert.deepEqual(world, { stripe: 1, stripeWrites: 0 });
});

test("a funded plan not activated yet stays unknown on the card, and the studio does not activate it", async () => {
  start();
  const { subscription } = await funded("paid");
  const before = snapshot();
  assert.match(before, /pending:card-funded/);
  calls.length = 0;
  const world = stripe(subscription);
  const live = await read("observe");
  assert.equal(live.state, "unknown", "the card says it could not confirm");
  assert.equal(planDueSoon(live, Math.floor(Date.now() / 1000)), null);
  assert.equal(snapshot(), before, "no activation, the pending reference stays for the return path or the sync");
  assert.deepEqual(scripts().map(writes), [false]);
  assert.deepEqual(world, { stripe: 1, stripeWrites: 0 });
});

test("a pending plan change is observed by the read-only switch proof, never activated", async () => {
  start();
  const { subscription, activation } = await funded("paid");
  assert.equal(await activateCheckoutContract(activation), true);
  const meta = subscription.metadata as Record<string, string>;
  const switching = { ...subscription, metadata: { ...meta, funding_action: "switch", funding_pending_grant: "ctr_switch_unknown", funding_pending_review: meta.funding_review } };
  const before = snapshot();
  calls.length = 0;
  const world = stripe(switching);
  const live = await read("observe");
  assert.equal(live.state, "unknown");
  assert.equal(snapshot(), before);
  assert.deepEqual(scripts().map((s) => [s.includes("local switchSource=redis.call"), writes(s)]), [[true, false]]);
  assert.deepEqual(world, { stripe: 1, stripeWrites: 0 });
});

test("every other caller keeps the activation it had", async () => {
  start();
  const { subscription } = await funded("paid");
  calls.length = 0;
  stripe(subscription);
  const live = await readSubscription(store.subscriptionId!, store);
  assert.equal(live.state, "active", "the sync's read activates the pending reference as before");
  assert.doesNotMatch(snapshot(), /pending:card-funded/);
  assert.deepEqual(scripts().map(writes), [true]);
  calls.length = 0;
  assert.equal((await readSubscription(store.subscriptionId!)).state, "unknown", "without a store it is still unknown");
  assert.equal(calls.length, 0);
});
