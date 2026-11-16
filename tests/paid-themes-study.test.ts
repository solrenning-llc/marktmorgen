import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { renderStudyTable, studyRows } from "./paid-themes-study-table";

const study = () => readFileSync("docs/paid-themes-study.md", "utf8");
const section = (text: string, heading: string) => {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, heading);
  const next = text.indexOf("\n## ", start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
};

test("section 5 prints exactly what lib/receiving-costs.ts computes, through a committed script", () => {
  const text = study();
  assert.ok(text.includes(renderStudyTable()), "section 5 table must equal renderStudyTable()");
  assert.ok(existsSync("scripts/paid-themes-study.mjs"), "scripts/paid-themes-study.mjs");
  assert.ok(readFileSync("scripts/paid-themes-study.mjs", "utf8").includes("paid-themes-study-table"));
  assert.ok(text.includes("node scripts/paid-themes-study.mjs"));
  assert.doesNotMatch(text, /outside the repository/);
  for (const rule of ["rounded up", "rounded down", "POSITIVE_NET_CENTS", "MOST_CORRECT_READING"]) assert.ok(text.includes(rule), rule);
});

test("the module types no fee, reserve or tax figure of its own", () => {
  const source = readFileSync("tests/paid-themes-study-table.ts", "utf8");
  assert.match(source, /from "@\/lib\/receiving-costs"/);
  for (const typed of [/\b290\b/, /\b150\b/, /\b2_?700\b/, /\b1_?500\b/, /\b3_?000\b/, /\b38\b/, /\b0\.38\b/, /\b0\.15\b/]) assert.doesNotMatch(source, typed);
  // Reading A loses at the owner's 10% before any other cost; reading B is positive before unknowns.
  for (const row of studyRows()) {
    assert.ok(row.readingACents < 0, `reading A at ${row.priceCents}`);
    assert.ok(row.readingBCents > 0, `reading B at ${row.priceCents}`);
    assert.ok(row.breakEvenBasisHundredths > 1_000, `break-even at ${row.priceCents}`);
  }
});

test("option 1 is positive only before the unknown costs, so it does not pass MR either (finding 1)", () => {
  const text = study();
  assert.doesNotMatch(text, /First-party sales pass per sale/);
  assert.doesNotMatch(text, /clearly positive/);
  assert.match(text, /option 1 does not pass the unit rule either/i);
  assert.match(section(text, "## 4."), /positive before the unknown costs/);
});

test("the 4.5:1 accent-text gap is recorded in the queue with the affected components (finding 2)", () => {
  const queue = readFileSync("docs/codex-queue.md", "utf8");
  const line = queue.split("\n").find((l) => l.includes("--st-accent-text") && l.includes("345 [RN3]"));
  assert.ok(line, "queue line naming --st-accent-text under 345 [RN3]");
  for (const fact of ["lib/store-look.ts", "4.5", "7:1", "1.4.6", "274 [AX1]", "components/store-cart.tsx", "components/course-outline.tsx", "components/store-product.tsx"]) assert.ok(line.includes(fact), fact);
  assert.ok(study().includes("--st-accent-text"));
});

test("no stale floor claim; the table names the code's reading (finding 4)", () => {
  const text = study();
  assert.doesNotMatch(text, /27\.5% floor/);
  assert.match(section(text, "## 5."), /MOST_CORRECT_READING/);
});

test("item 345's remaining scope is addressed as unknowns or owner decisions (finding 5)", () => {
  const text = study();
  for (const fact of ["minimum base", "FX275", "License", "Updates and compatibility", "TX point 11", "TX point 14", "per-plan caps"]) assert.ok(text.includes(fact), fact);
});

test("internal consistency and the Shopify direct-read caveat (findings 6 and 7)", () => {
  const text = study();
  assert.doesNotMatch(text, /Every marketplace above uses human review/);
  assert.ok(text.includes("Every curated marketplace"));
  assert.doesNotMatch(section(text, "## 3."), /Shopify below US\$1M, Framer, Wix, Webflow/);
  for (const source of text.matchAll(/^\| (S\d+) \|/gm)) assert.ok(text.includes(`[${source[1]}]`), `${source[1]} cited`);
  assert.match(section(text, "## 6."), /revenue-share page[^\n]*read via excerpt only; confirm directly before any decision/);
});
