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
  for (const annual of ["$120", "$240", "$1,200", "$2,400", "$4,800", "$9,600", "$18,000"])
    assert.ok(text.includes(annual), annual);
});

test("PAYG monthly and twelve-worst-month Redis components stay explicit for every customer plan", () => {
  const text = decision();
  for (const row of [
    "| Store | month | $3.208618 | $0.659180 | $0.037784 | **$3.905582** |",
    "| Store | 12 worst months | $38.503413 | $7.910156 | $0.453409 | **$46.866978** |",
    "| Studio | month | $4.990522 | $0.718050 | $0.110816 | **$5.819388** |",
    "| Studio | 12 worst months | $59.886261 | $8.616606 | $1.329794 | **$69.832660** |",
    "| Scale | month | $8.203842 | $0.820725 | $0.249999 | **$9.274567** |",
    "| Scale | 12 worst months | $98.446101 | $9.848706 | $2.999992 | **$111.294799** |",
  ]) assert.ok(text.includes(row), row);

  for (const [month, year] of [[3.905581523, 46.866978271], [5.819388373, 69.832660474], [9.274566588, 111.29479906]])
    assert.ok(Math.abs(month * 12 - year) < 1e-8, `${month} × 12 = ${year}`);
});

test("separately zeroed rates are described as conservative sensitivities, not exact attribution", () => {
  const text = decision();
  assert.match(text, /conservative sum of separate rate\s+sensitivities/i);
  assert.match(text, /not\s+disjoint supplier components/i);
  assert.doesNotMatch(text, /approximately [\d,]+[\s\S]*modeled commands per worst month/i);
});

test("the Scale annual transfer sensitivity is derived from the exact model value", () => {
  const text = decision();
  const scaleMonthlyTransferSensitivity = 0.8207254713460017;
  const annual = (scaleMonthlyTransferSensitivity * 12).toFixed(6);
  assert.equal(annual, "9.848706");
  assert.ok(text.includes(`$${annual}`), `Scale annual transfer sensitivity: $${annual}`);
});

test("the fixed comparison assigns the whole fixed fee to an isolated store and remains conditional", () => {
  const text = decision();
  for (const row of [
    "| Store | $3.905582 | $46.866978 | Fixed 1 GB | $20 | $240 | PAYG is cheaper |",
    "| Studio | $5.819388 | $69.832660 | Fixed 5 GB | $100 | $1,200 | PAYG is cheaper |",
    "| Scale | $9.274567 | $111.294799 | Fixed 5 GB | $100 | $1,200 | PAYG is cheaper |",
  ]) assert.ok(text.includes(row), row);
  assert.match(text, /zero read regions[\s\S]*no Prod Pack[\s\S]*one full store/i);
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
