/**
 * 22 [E5] unit 3b, first part: the creator's account settlement currency, read for a checkout only behind
 * BUYER_CURRENCY_LIVE, is paid for and kept before the key can turn on (docs/buyer-currency-and-language.md, unit 3b:
 * "cache and units for the account read"). Synthetic Stripe and Redis only.
 *
 *   - one buyer request unit is taken before anything is read; refused, nothing is read and the answer is unknown;
 *   - a kept answer is read back without asking Stripe; a kept value of another shape is never used;
 *   - Stripe's answer is kept SETTLEMENT_CURRENCY_SECONDS; an unknown answer is never kept.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SETTLEMENT_CURRENCY_SECONDS, settlementCurrencyFor, settlementKey } from "@/lib/buyer-currency";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_buyer_currency_cache_only";
const ACCOUNT = "acct_1TestSettleCache1";
let account: Record<string, unknown> | "fail" = {};
let stripeAsked = 0;
globalThis.fetch = (async () => {
  stripeAsked += 1;
  if (account === "fail") return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  return new Response(JSON.stringify(account), { status: 200 });
}) as typeof fetch;

const store = { stripeAccountId: ACCOUNT } as never;
let taken: number[] = [];
const allow = async (_store: unknown, units?: number) => (taken.push(units ?? 1), true);
const refuse = async (_store: unknown, units?: number) => (taken.push(units ?? 1), false);
const fresh = () => { redis.clear(); stripeAsked = 0; taken = []; };

test("refused, nothing is read and the answer is unknown", async () => {
  fresh();
  account = { id: ACCOUNT, default_currency: "usd" };
  assert.equal(await settlementCurrencyFor(store, refuse), null);
  assert.deepEqual(taken, [1]);
  assert.equal(stripeAsked, 0);
});

test("read from Stripe once, kept, then read back without asking Stripe, a unit taken each time", async () => {
  fresh();
  account = { id: ACCOUNT, default_currency: "EUR" };
  assert.equal(await settlementCurrencyFor(store, allow), "eur");
  assert.equal(stripeAsked, 1);
  const [kept, ttl] = await redis.pipeline([["GET", settlementKey(ACCOUNT)], ["TTL", settlementKey(ACCOUNT)]]);
  assert.equal(kept, "eur");
  assert.ok(typeof ttl === "number" && ttl > 0 && ttl <= SETTLEMENT_CURRENCY_SECONDS);
  account = { id: ACCOUNT, default_currency: "usd" };
  assert.equal(await settlementCurrencyFor(store, allow), "eur", "the kept answer, not a new read");
  assert.equal(stripeAsked, 1);
  assert.deepEqual(taken, [1, 1]);
});

test("an unknown answer is never kept, and a kept value of another shape is never used", async () => {
  fresh();
  account = "fail";
  assert.equal(await settlementCurrencyFor(store, allow), null);
  account = { id: ACCOUNT };
  assert.equal(await settlementCurrencyFor(store, allow), null);
  assert.equal((await redis.pipeline([["GET", settlementKey(ACCOUNT)]]))[0], null);
  for (const bad of ["EUR", "eu", "euro", "", "1"]) {
    fresh();
    await redis.pipeline([["SET", settlementKey(ACCOUNT), bad, "EX", 60]]);
    account = { id: ACCOUNT, default_currency: "gbp" };
    assert.equal(await settlementCurrencyFor(store, allow), "gbp", JSON.stringify(bad));
    assert.equal(stripeAsked, 1, "a value of another shape is read again from Stripe");
  }
});

test("no account: nothing taken, nothing read", async () => {
  fresh();
  assert.equal(await settlementCurrencyFor({ stripeAccountId: "" } as never, allow), null);
  assert.deepEqual(taken, []);
  assert.equal(stripeAsked, 0);
});

test("the checkout asks through the paid, kept read", () => {
  const checkout = readFileSync("lib/store-checkout.ts", "utf8");
  assert.ok(checkout.includes("settles: settlesIn(store.currency, await settlementCurrencyFor(store))"));
  assert.ok(!checkout.includes("accountSettlementCurrency(store.stripeAccountId)"));
});
