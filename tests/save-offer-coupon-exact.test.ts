/**
 * #4697 (Codex X8): the stay-offer coupon was kept on its id alone. A coupon that came back from Stripe with 50% off,
 * three months, or `valid: false` was announced as the 10% for two months the creator asked for. A coupon is now kept
 * only when Stripe's answer is the coupon that was asked for: object, percent, duration, months and validity.
 * Synthetic Stripe stand-in; no real account.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeSaveCoupon } from "@/lib/save-offer-coupon";
import type { Store } from "@/lib/store";

process.env.STRIPE_SECRET_KEY = "sk_test_save_offer_coupon_exact";
let reply: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname === "/v1/coupons" && (init?.method ?? "GET") === "POST") return Response.json(reply);
  return Response.json({ error: { message: "unexpected" } }, { status: 404 });
}) as typeof fetch;

const store = { stripeAccountId: "acct_1SaveCouponExact" } as unknown as Store;
const twoMonths = { id: "SAVE10X2", object: "coupon", percent_off: 10, amount_off: null, duration: "repeating", duration_in_months: 2, valid: true };
const oneMonth = { id: "SAVE10X1", object: "coupon", percent_off: 10, amount_off: null, duration: "once", duration_in_months: null, valid: true };

async function made(answer: Record<string, unknown>, months: number): Promise<string> {
  reply = answer;
  try {
    return await makeSaveCoupon(store, 10, months);
  } catch {
    return "refused";
  }
}

test("(control) the coupon asked for is kept", async () => {
  assert.equal(await made(twoMonths, 2), "SAVE10X2");
  assert.equal(await made(oneMonth, 1), "SAVE10X1");
});

for (const [what, patch] of [
  ["50% off", { percent_off: 50 }],
  ["three months", { duration_in_months: 3 }],
  ["valid: false", { valid: false }],
  ["another object", { object: "promotion_code" }],
  ["an amount off besides the percent", { amount_off: 500 }],
  ["forever", { duration: "forever", duration_in_months: null }],
  ["once", { duration: "once", duration_in_months: null }],
  ["a deleted coupon", { deleted: true }],
  ["no percent", { percent_off: null }],
  ["the percent as text", { percent_off: "10" }],
] as const) {
  test(`a coupon that came back with ${what} is not kept as 10% for two months`, async () => {
    assert.equal(await made({ ...twoMonths, ...patch }, 2), "refused");
  });
}

test("a one-month coupon that came back repeating is not kept", async () => {
  assert.equal(await made({ ...oneMonth, duration: "repeating", duration_in_months: 1 }, 1), "refused");
});
