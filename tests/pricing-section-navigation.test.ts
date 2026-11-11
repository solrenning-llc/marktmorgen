import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { PRICING_GROUPS, PRICING_PLANS } from "@/lib/pricing-page-data";

// Match the existing pricing-page contract: inspect the real page and canonical
// facts without executing Next font loaders in the standalone Node runner.
const page = readFileSync("app/pricing/page.tsx", "utf8");
const calculator = readFileSync("components/tools-calculator.tsx", "utf8");
const planFit = readFileSync("components/plan-fit-calculator.tsx", "utf8");

test("pricing has seven native section links, in page order, with unique real destinations", () => {
  const nav = /<nav\b[^>]*aria-label="Pricing sections"[^>]*>([\s\S]*?)<\/nav>/.exec(page);
  assert.ok(nav, "the long page needs its own section index, separate from the shared header");
  const links = [...nav[1].matchAll(/<a\b[^>]*href="(#[^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(links, ["#plans", "#limits-heading", "#addons-heading", "#plan-fit-heading", "#calculator-heading", "#compare-heading", "#faq-heading"]);
  const ids = [...(page + calculator + planFit).matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  for (const href of links) assert.equal(ids.filter(id => id === href.slice(1)).length, 1);
});

test("every allowance table is available at mobile width without a second stacked copy", () => {
  assert.equal([...page.matchAll(/<table\b/g)].length, 1, "one table template serves each canonical group");
  assert.doesNotMatch(page, /hidden\s+md:block/, "the comparison table cannot disappear on mobile");
  assert.doesNotMatch(page, /<dl\b[^>]*md:hidden/, "avoid repeating the three plans as tall mobile lists");
});

test("the page maps every canonical group, row, period, note and plan value", () => {
  for (const mapping of ["PRICING_GROUPS.map", "group.rows.map", "PRICING_PLANS.map", "row.values[p.tier]", "row.label", "row.note", "group.period"]) assert.ok(page.includes(mapping), mapping);
  assert.equal(PRICING_PLANS.length, 3);
  assert.ok(PRICING_GROUPS.length > 0);
  for (const group of PRICING_GROUPS) {
    assert.ok(group.period.length > 0);
    for (const row of group.rows) {
      assert.ok(row.label.length > 0);
      for (const plan of PRICING_PLANS) assert.equal(typeof row.values[plan.tier], "string", row.key);
    }
  }
  assert.ok(page.includes("Permissions, consent, funding checks and feature availability still apply."));
  assert.ok(page.includes("Annual billing does not turn a monthly allowance into a yearly pool."));
});

test("the index is sticky and touch-sized using pricing-only CSS, without hiding rows", () => {
  const css = existsSync("app/pricing/pricing.css") ? readFileSync("app/pricing/pricing.css", "utf8") : "";
  assert.match(css, /\.pricing-section-index\s*\{[^}]*position:\s*sticky/);
  assert.match(css, /\.pricing-section-index a\s*\{[^}]*min-height:\s*44px/);
  assert.doesNotMatch(css, /display:\s*none|visibility:\s*hidden|overflow:\s*hidden/);
});
