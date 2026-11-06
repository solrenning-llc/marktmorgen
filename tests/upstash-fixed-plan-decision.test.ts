import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const DOC = "docs/upstash-fixed-plan-decision-2026-11-06.md";
const decision = () => readFileSync(DOC, "utf8");

test("the Upstash decision is dated, source-bound, and does not change the account", () => {
  const text = decision();
  for (const fact of [
    "6 November 2026",
    "https://upstash.com/pricing/redis.md",
    "https://upstash.com/docs/redis/features/auto-upgrade",
    "https://upstash.com/docs/devops/developer-api/redis/change_plan",
    "No account change was made",
  ]) assert.ok(text.includes(fact), fact);
});

test("every published fixed tier keeps price, capacity, throughput, and read-region cost together", () => {
  const text = decision();
  for (const row of [
    "| Fixed 250 MB | $10 | $5 | 250 MB | 50 GB | 10,000 |",
    "| Fixed 1 GB | $20 | $10 | 1 GB | 100 GB | 10,000 |",
    "| Fixed 5 GB | $100 | $50 | 5 GB | 500 GB | 10,000 |",
    "| Fixed 10 GB | $200 | $100 | 10 GB | 1 TB | 10,000 |",
    "| Fixed 50 GB | $400 | $200 | 50 GB | 5 TB | 10,000 |",
    "| Fixed 100 GB | $800 | $400 | 100 GB | 10 TB | 16,000 |",
    "| Fixed 500 GB | $1,500 | $750 | 500 GB | 20 TB | 16,000 |",
  ]) assert.ok(text.includes(row), row);
});

test("the decision refuses to turn missing live aggregate evidence into zero", () => {
  const text = decision();
  for (const fact of [
    "unknown, never zero",
    "live aggregate data size",
    "live peak commands per second",
    "live monthly bandwidth",
    "Do not change the real database yet",
  ]) assert.ok(text.includes(fact), fact);
});

test("the runbook stops before billing confirmation and requires automatic ceilings first", () => {
  const text = decision();
  assert.match(text, /Redis[\s\S]*database[\s\S]*Settings[\s\S]*Change Plan/i);
  assert.match(text, /Auto Upgrade[\s\S]*disabled/i);
  assert.match(text, /stop before[\s\S]*(?:confirm|confirmation)/i);
  assert.match(text, /throughput ceiling[\s\S]*data-size ceiling[\s\S]*before/i);
});
