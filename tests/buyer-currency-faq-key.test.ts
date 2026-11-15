/**
 * Claude 7's LEVE 1 on #4577: the buyer-facing answer "Can my buyers pay in their own currency?" is tied to
 * BUYER_CURRENCY_LIVE in both directions, so the key can never be turned on while the FAQ still says "No" (VR 2), nor
 * the FAQ changed while the key is off.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUYER_CURRENCY_LIVE } from "@/lib/buyer-currency";

const faq = readFileSync("lib/currency-faq.ts", "utf8");
const saysNo = faq.includes("No. Our checkout asks Stripe not to convert");

test("the FAQ says no exactly while the key is off", () => {
  assert.equal(saysNo, !BUYER_CURRENCY_LIVE, BUYER_CURRENCY_LIVE
    ? "the key is on: lib/currency-faq.ts must stop saying buyers cannot pay in their own currency"
    : "the key is off: lib/currency-faq.ts must keep saying no");
});
