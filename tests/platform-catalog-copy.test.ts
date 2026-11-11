import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("app/platform/page.tsx", "utf8");
const checkout = readFileSync("lib/store-checkout.ts", "utf8");

test("the paid-tools summary does not promise a sales outcome", () => {
  assert.doesNotMatch(page, /tools that raise each sale/i);
});

test("the paid-tools summary states the real conditional checkout path", () => {
  assert.match(
    page,
    /Your connected Stripe account handles checkout when paid selling is available\./,
  );
  assert.match(page, /Paid selling is not open yet\./);
  assert.ok(
    checkout.includes(
      'onAccount("POST", store.stripeAccountId as string, "/checkout/sessions"',
    ),
    "the checkout implementation uses the connected account named by the copy",
  );
});
