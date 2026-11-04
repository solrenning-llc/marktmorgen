import assert from "node:assert/strict";
import test from "node:test";
import { paypalSalesConfigured } from "@/lib/paypal-sales";
import {
  AFFILIATES_PAID,
  PAYPAL_NOT_YET,
  PAYPAL_WAITS,
  STAN_AFFILIATES_AHEAD,
  checkoutQuestionWords,
  paypalAtCheckout,
  paypalConnectionWords,
} from "@/lib/public-explanations";
import { FIELD_TYPES, MAX_CHECKOUT_FIELDS, readFields } from "@/lib/checkout-fields";
import { postBySlug } from "@/lib/blog";
import { findPage } from "@/lib/site-pages";
import { FEATURE_PAGES } from "@/lib/feature-pages";
import * as help from "@/lib/help-content";

/** Every string a public page carries, deep. */
function words(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(words);
  if (value && typeof value === "object") return Object.values(value).flatMap(words);
  return [];
}

const KEYS = ["PAYPAL_PARTNER_CLIENT_ID", "PAYPAL_PARTNER_SECRET", "PAYPAL_PARTNER_MERCHANT_ID", "PAYPAL_BN_CODE"] as const;

test("the pages' PayPal reading is the PayPal client's own, for every way the credentials can be set", () => {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const cases: Record<string, string | undefined>[] = [
    {},
    { PAYPAL_PARTNER_CLIENT_ID: "client", PAYPAL_PARTNER_SECRET: "secret", PAYPAL_PARTNER_MERCHANT_ID: "ABCD1234EF", PAYPAL_BN_CODE: "bn" },
    { PAYPAL_PARTNER_CLIENT_ID: "client", PAYPAL_PARTNER_SECRET: "secret", PAYPAL_PARTNER_MERCHANT_ID: "abc", PAYPAL_BN_CODE: "bn" },
    { PAYPAL_PARTNER_CLIENT_ID: " ", PAYPAL_PARTNER_SECRET: "secret", PAYPAL_PARTNER_MERCHANT_ID: "ABCD1234EF", PAYPAL_BN_CODE: "bn" },
    { PAYPAL_PARTNER_CLIENT_ID: "client", PAYPAL_PARTNER_SECRET: "secret", PAYPAL_PARTNER_MERCHANT_ID: "ABCD1234EF" },
    { PAYPAL_PARTNER_CLIENT_ID: "client", PAYPAL_PARTNER_SECRET: "secret", PAYPAL_PARTNER_MERCHANT_ID: " ABCD1234EFGH5678IJKL ", PAYPAL_BN_CODE: "bn" },
    { PAYPAL_PARTNER_CLIENT_ID: "client", PAYPAL_PARTNER_SECRET: "secret", PAYPAL_PARTNER_MERCHANT_ID: "ABCD1234EFGH5678IJKLM", PAYPAL_BN_CODE: "bn" },
  ];
  try {
    for (const env of cases) {
      for (const key of KEYS) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
      }
      assert.equal(paypalAtCheckout(), paypalSalesConfigured(), JSON.stringify(env));
      assert.equal(paypalAtCheckout(env), paypalSalesConfigured(), JSON.stringify(env));
    }
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("the blog and the comparisons explain PayPal and affiliates the same way", () => {
  const stanPost = words(postBySlug("how-marktmorgen-compares-with-stan")).join("\n");
  const compare = words(findPage("proof", "compare")).join("\n");
  const everything = words(findPage("proof", "everything")).join("\n");
  const beacons = words(findPage("proof", "beacons")).join("\n");
  assert.ok(compare && everything && beacons);
  for (const page of [stanPost, compare, everything, beacons]) {
    assert.doesNotMatch(page, /Stripe does not support it for the direct charges/);
    assert.doesNotMatch(page, /our affiliates are paid by you/);
  }
  // Whichever way PayPal is set on this run, every page says the same thing about it.
  const on = paypalAtCheckout();
  const connection = paypalConnectionWords(on);
  assert.ok(stanPost.includes(connection));
  if (!on) {
    for (const page of [stanPost, compare, everything, beacons]) assert.ok(page.includes(PAYPAL_WAITS));
    assert.ok(PAYPAL_NOT_YET.endsWith(PAYPAL_WAITS));
  }
  for (const page of [stanPost, compare]) assert.ok(page.includes(STAN_AFFILIATES_AHEAD));
  assert.ok(stanPost.includes(AFFILIATES_PAID));
  assert.ok(stanPost.includes(STAN_AFFILIATES_AHEAD));
  // The list of what we lack no longer names automatic affiliate payouts, which lib/paypal-payouts.ts does.
  const range = stanPost.split("\n").find((line) => line.startsWith("Range:")) ?? "";
  assert.ok(range);
  assert.doesNotMatch(range.split("We have none of those.")[0], /affiliates paid automatically/);
  assert.match(stanPost, /Corrected on November 1, 2026/);
});

test("the checkout questions row says what the checkout really asks", () => {
  const row = checkoutQuestionWords();
  assert.equal(row, "Up to three: a short answer, a number, a list to choose from or a phone number in Stripe's own box. No checkbox question");
  assert.equal(MAX_CHECKOUT_FIELDS, 3);
  // A phone number is accepted by the studio's own reading, so the row must not deny it.
  assert.ok(FIELD_TYPES.includes("phone"));
  assert.deepEqual(readFields([{ type: "phone" }]), [{ label: "Phone number", type: "phone", optional: false, options: [] }]);
  assert.match(row, /phone number/);
  assert.doesNotMatch(row, /No phone/i);
  const everything = words(findPage("proof", "everything")).join("\n");
  assert.ok(everything.includes(row));
  assert.doesNotMatch(everything, /No phone-number or checkbox question/);
});

test("no public page or help answer still contradicts the checkout or PayPal explanation", () => {
  const all = [words(help), words(FEATURE_PAGES), words(findPage("proof", "everything")), words(postBySlug("how-marktmorgen-compares-with-stan"))].flat().join("\n");
  assert.doesNotMatch(all, /no phone-number or checkbox question/i);
  assert.doesNotMatch(all, /runs on Stripe and only Stripe/);
  assert.doesNotMatch(all, /The other road would be a second, separate integration with PayPal/);
  assert.doesNotMatch(all, /^Stripe only\./m);
  assert.ok(all.includes(paypalConnectionWords()));
  // Both states read as whole sentences.
  for (const on of [true, false]) assert.match(paypalConnectionWords(on), /^A separate PayPal connection[^.]*\b(on|yet)\b.*\.$/);
});
