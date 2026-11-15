/**
 * 22 [E5] unit 3b, the coordinator's care item 4: a fixed-amount coupon, pay what you want's minimum, a checkout box
 * (order bump), a membership's introductory price and a manual capture each wait for their own test-mode proof. Until
 * then a session holding any of them stays in the store's currency, whatever the creator chose
 * (docs/buyer-currency-and-language.md, the care list). Pure; the key stays off.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUYER_CURRENCY_LIVE, buyerCurrencyPlan, heldReasons } from "@/lib/buyer-currency";

const base = { live: true, mode: "automatic" as const, fee: false, settles: true, manualPrices: false, taxRates: false };
const none = { body: new URLSearchParams(), pwyw: false, bumps: 0, intro: false, mayComeOff: [] };

test("nothing held: the plan is as before", () => {
  assert.deepEqual(heldReasons(none), []);
  assert.deepEqual(buyerCurrencyPlan({ ...base, held: [] }), { adaptive: true, manual: false, why: "automatic" });
  assert.deepEqual(buyerCurrencyPlan(base), { adaptive: true, manual: false, why: "automatic" }, "held defaults to none");
});

test("each care-4 case is named", () => {
  assert.deepEqual(heldReasons({ ...none, mayComeOff: [{ kind: "cents", cents: 500 }] }), ["fixed-coupon"]);
  assert.deepEqual(heldReasons({ ...none, mayComeOff: [{ kind: "unknown" }] }), ["fixed-coupon"], "a coupon of unknown kind may be fixed");
  assert.deepEqual(heldReasons({ ...none, mayComeOff: [{ kind: "percent", percent: 20 }] }), [], "a percentage converts with the price");
  assert.deepEqual(heldReasons({ ...none, body: new URLSearchParams({ allow_promotion_codes: "true" }) }), ["fixed-coupon"], "a typed code may be fixed");
  assert.deepEqual(heldReasons({ ...none, pwyw: true }), ["pwyw"]);
  assert.deepEqual(heldReasons({ ...none, bumps: 1 }), ["bump"]);
  assert.deepEqual(heldReasons({ ...none, intro: true }), ["intro"]);
  assert.deepEqual(heldReasons({ ...none, body: new URLSearchParams({ "payment_intent_data[capture_method]": "manual" }) }), ["manual-capture"]);
  assert.deepEqual(heldReasons({ ...none, body: new URLSearchParams({ "payment_intent_data[capture_method]": "automatic" }) }), []);
  assert.deepEqual(heldReasons({ body: new URLSearchParams({ allow_promotion_codes: "true" }), pwyw: true, bumps: 2, intro: true, mayComeOff: [] }), ["fixed-coupon", "pwyw", "bump", "intro"]);
});

test("anything held keeps the store's currency in both ways, after the key and before the creator's choice counts", () => {
  for (const mode of ["automatic", "manual"] as const) {
    assert.deepEqual(buyerCurrencyPlan({ ...base, mode, manualPrices: true, held: ["bump"] }), { adaptive: false, manual: false, why: "held" });
  }
  assert.equal(buyerCurrencyPlan({ ...base, live: false, held: ["bump"] }).why, "off");
});

test("the checkout passes what it holds, still only behind the key", () => {
  assert.equal(BUYER_CURRENCY_LIVE, false);
  const checkout = readFileSync("lib/store-checkout.ts", "utf8");
  assert.ok(checkout.includes("held: heldReasons({ body, pwyw: Boolean(pwyw), bumps: added.length, intro: Boolean(intro), mayComeOff })"));
});
