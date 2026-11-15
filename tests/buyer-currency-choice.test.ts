/**
 * 22 [E5] unit 3b: the creator's choice between (a) automatic and (b) manual is kept on the store record. A store that
 * never chose is (a), the owner's default; a kept value of another shape is unknown, which keeps the store's currency
 * (lib/buyer-currency.ts buyerCurrencyPlan, "mode-unknown"). The checkout reads it, still only behind
 * BUYER_CURRENCY_LIVE (false). Synthetic Redis only.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buyerCurrencyModeOf } from "@/lib/buyer-currency";
import { claimHandle, setBuyerCurrency, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

const OWNER = "choice-owner@example.com";

test("a store that never chose is (a); each choice is kept and read back", async () => {
  redis.clear();
  await claimHandle(OWNER, "choicestore", "Choice", "");
  const before = (await storeForEmail(OWNER))!;
  assert.equal(before.buyerCurrency, undefined);
  assert.equal(buyerCurrencyModeOf(before), "automatic");
  for (const mode of ["manual", "automatic"] as const) {
    const saved = await setBuyerCurrency(OWNER, mode);
    assert.equal(saved.ok, true);
    assert.equal(buyerCurrencyModeOf((await storeForEmail(OWNER))!), mode);
  }
});

test("anything else is never saved, and a kept value of another shape reads as unknown", async () => {
  redis.clear();
  await claimHandle(OWNER, "choicestore", "Choice", "");
  for (const bad of ["Manual", "both", "", 1, null]) {
    assert.deepEqual(await setBuyerCurrency(OWNER, bad as never), { ok: false, reason: "invalid" }, JSON.stringify(bad));
  }
  assert.equal(buyerCurrencyModeOf({ buyerCurrency: "both" } as never), "unknown");
  assert.equal(buyerCurrencyModeOf({ buyerCurrency: "unknown" } as never), "unknown");
  assert.equal(buyerCurrencyModeOf({} as never), "automatic");
});

test("the checkout passes the store's own choice", () => {
  const checkout = readFileSync("lib/store-checkout.ts", "utf8");
  assert.ok(checkout.includes("mode: buyerCurrencyModeOf(store),"));
  assert.ok(!checkout.includes("mode: DEFAULT_BUYER_CURRENCY_MODE,"));
});

/**
 * 208 [SH5]'s condition, second half (Claude 7 on #4579): the creator can switch the buyer's currency off. "off"
 * keeps every session in the store's currency, whatever else holds, and is kept like the two ways.
 */
test("the creator's switch: off keeps the store's currency, and is kept", async () => {
  const { buyerCurrencyPlan } = await import("@/lib/buyer-currency");
  const base = { live: true, fee: false, settles: true, manualPrices: true, taxRates: false };
  assert.deepEqual(buyerCurrencyPlan({ ...base, mode: "off" }), { adaptive: false, manual: false, why: "creator-off" });
  redis.clear();
  await claimHandle(OWNER, "choicestore", "Choice", "");
  assert.equal((await setBuyerCurrency(OWNER, "off")).ok, true);
  assert.equal(buyerCurrencyModeOf((await storeForEmail(OWNER))!), "off");
});
