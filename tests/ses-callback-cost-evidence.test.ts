import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PLAN_PRICES, PRO_MONTHLY_EMAILS, SCALE_MONTHLY_EMAILS } from "@/lib/plan";

const path = "docs/ses-callback-cost-2026-11-05.md";
const evidence = () => readFileSync(path, "utf8");

test("DR1 callback evidence preserves the unresolved admission and upstream bounds", () => {
  const text = evidence();
  for (const statement of [
    "Evidence checked: November 4, 2026 (America/Fortaleza).",
    "CURRENT_MAIL_REPORT_ADMISSION remains null",
    "callbackAttemptsPerEmailCeiling remains unknown",
    "101 is a retry-policy scenario, not a proven whole-email lifecycle ceiling",
    "No report operation, SES setting, subscription, price, entitlement or flag changes",
  ]) assert.ok(text.includes(statement), statement);
});

test("DR1 evidence links the primary tariff, retry, delivery and byte sources", () => {
  const text = evidence();
  for (const url of [
    "https://aws.amazon.com/sns/faqs/",
    "https://aws.amazon.com/sns/pricing/",
    "https://docs.aws.amazon.com/sns/latest/dg/sns-message-delivery-retries.html",
    "https://aws.amazon.com/sns/features/",
    "https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html",
    "https://vercel.com/docs/functions/usage-and-pricing",
    "https://vercel.com/docs/manage-cdn-usage",
    "https://upstash.com/pricing/redis",
  ]) assert.ok(text.includes(url), url);
});

// Independent exact rational oracle: USD numerator / denominator. No supplier,
// free-tier credit or unknown component enters this compute-only scenario.
const seconds = BigInt(30);
const invocationMicroUsdPerMillion = BigInt(600_000);
const cpuMicroUsdPerHour = BigInt(128_000);
const memoryMicroUsdPerGbHour = BigInt(10_600);
const denominator = BigInt(3_600_000_000_000_000);
const numerator = invocationMicroUsdPerMillion * BigInt(3_600)
  + (seconds * cpuMicroUsdPerHour + seconds * BigInt(2) * memoryMicroUsdPerGbHour) * BigInt(1_000_000);

function ceilMicroUsd(emails: number, attempts: number): bigint {
  const n = numerator * BigInt(emails) * BigInt(attempts) * BigInt(1_000_000);
  return (n + denominator - BigInt(1)) / denominator;
}

test("the dated table reproduces the full 30-second IAD compute envelope without rounding down", () => {
  const text = evidence();
  const rows = [
    [PRO_MONTHLY_EMAILS, 1, BigInt(8_707_534)],
    [PRO_MONTHLY_EMAILS, 4, BigInt(34_830_134)],
    [PRO_MONTHLY_EMAILS, 101, BigInt(879_460_867)],
    [SCALE_MONTHLY_EMAILS, 1, BigInt(12_439_334)],
    [SCALE_MONTHLY_EMAILS, 4, BigInt(49_757_334)],
    [SCALE_MONTHLY_EMAILS, 101, BigInt(1_256_372_667)],
  ] as const;
  for (const [emails, attempts, expected] of rows) {
    assert.equal(ceilMicroUsd(emails, attempts), expected);
    const dollars = `${expected / BigInt(1_000_000)}.${String(expected % BigInt(1_000_000)).padStart(6, "0")}`;
    assert.ok(text.includes(`| ${emails} | ${attempts} | ${emails * attempts} | ${dollars} |`));
  }
});

test("the 101-attempt compute envelope already exceeds both paid list plans' gross revenue", () => {
  const text = evidence();
  for (const [tier, emails] of [["pro", PRO_MONTHLY_EMAILS], ["scale", SCALE_MONTHLY_EMAILS]] as const) {
    const worst = numerator * BigInt(emails) * BigInt(101);
    assert.ok(worst * BigInt(100) > BigInt(PLAN_PRICES[tier].month) * denominator);
    assert.ok(worst * BigInt(1_200) > BigInt(PLAN_PRICES[tier].year) * denominator);
  }
  assert.ok(text.includes("This rejects the present admission model; it does not establish an actual invoice or measured loss."));
  assert.ok(text.includes("Excluded costs remain unknown or separately chargeable, never zero."));
});

test("the evidence distinguishes counted outcomes, provider publications and billed attempts", () => {
  const text = evidence();
  for (const requirement of [
    "effective HTTP/S delivery policy",
    "redrive and replay",
    "DeliveryDelay publication count",
    "read-region replication",
    "before the first SES send",
    "Rejected and duplicate callbacks still incur hosting work",
    "30-day retention is not shipped",
  ]) assert.ok(text.includes(requirement), requirement);
});
