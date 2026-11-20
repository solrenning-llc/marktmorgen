/**
 * 9 [C-US] unit 1: the per-state US sales tax table (lib/us-sales-tax-rules.ts). It holds that every state and DC is
 * there once; that every known answer names an official page and quotes it; that unknown is said, never filled; that
 * the thresholds are whole figures as the states write them; and that nothing reads the table yet (no counter, no
 * checkout, no flag). The quotes themselves were checked against their pages when the table was written; this test
 * cannot reach the network, so it holds the shape that keeps a guess out.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { US_SALES_TAX_READ_ON, US_SALES_TAX_RULES, type UsSalesTaxRead, usSalesTaxRule } from "@/lib/us-sales-tax-rules";

const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
/** Hosts that are a state's own: a .gov host, a state.xx.us host, Alaska's remote seller commission and Florida's revenue department. */
const official = (url: string) => {
  const { protocol, hostname } = new URL(url);
  return protocol === "https:" && (hostname.endsWith(".gov") || /\.state\.[a-z]{2}\.us$/.test(hostname) || hostname === "arsstc.org" || hostname === "floridarevenue.com");
};
const fields = (rule: (typeof US_SALES_TAX_RULES)[number]): [string, UsSalesTaxRead<unknown>][] => [
  ["stateSalesTax", rule.stateSalesTax],
  ["marketplaceFacilitator", rule.marketplaceFacilitator],
  ["threshold", rule.threshold],
  ["digitalProducts", rule.digitalProducts],
  ["saas", rule.saas],
];

test("every state and the District of Columbia, once each, read on one day", () => {
  assert.deepEqual(US_SALES_TAX_RULES.map((rule) => rule.state), STATES);
  assert.equal(US_SALES_TAX_READ_ON, "2026-11-20");
  assert.equal(usSalesTaxRule("TX")?.state, "TX");
  assert.equal(usSalesTaxRule("PR"), null);
});

test("a known answer names an official page and quotes it; an unknown one says why", () => {
  for (const rule of US_SALES_TAX_RULES) {
    for (const [name, read] of fields(rule)) {
      const where = `${rule.state} ${name}`;
      if (read.known) {
        assert.equal(official(read.source.url), true, `${where}: ${read.source.url}`);
        assert.ok(read.source.quote.trim().length >= 12 && read.source.quote.length <= 600, where);
      } else {
        assert.ok(read.gap.trim().length > 0, where);
      }
    }
  }
});

test("thresholds are whole figures as written; a transaction test always says how it joins", () => {
  for (const rule of US_SALES_TAX_RULES) {
    const read = rule.threshold;
    if (!read.known) continue;
    if (read.value === "no-state-sales-tax") {
      assert.deepEqual([rule.stateSalesTax.known, rule.stateSalesTax.known && rule.stateSalesTax.value], [true, false], rule.state);
      continue;
    }
    const { salesUsd, transactions, joiner, period } = read.value;
    assert.ok(Number.isInteger(salesUsd) && salesUsd >= 10_000 && salesUsd <= 1_000_000, rule.state);
    if (transactions === null) assert.equal(joiner, null, rule.state);
    else assert.ok(Number.isInteger(transactions) && transactions > 0 && (joiner === "and" || joiner === "or"), rule.state);
    assert.ok(period.trim().length > 0, rule.state);
  }
});

// Claude 5's LOW on #4957: a threshold's own quote must show the figures it backs, not only `counts`, because the next
// unit wires them into a counter. The dollars as the page writes them (100,000), and the transaction count, in figures or in words.
test("a known threshold's quote shows its own dollars and its transaction count", () => {
  for (const rule of US_SALES_TAX_RULES) {
    const read = rule.threshold;
    if (!read.known || read.value === "no-state-sales-tax") continue;
    const quote = read.source.quote;
    assert.equal(quote.includes(read.value.salesUsd.toLocaleString("en-US")), true, `${rule.state}: ${read.value.salesUsd}`);
    // The count in figures, or in words as a statute may write it (Hawaii's "two hundred or more separate transactions").
    const IN_WORDS: Record<number, string> = { 100: "one hundred", 200: "two hundred" };
    const count = read.value.transactions;
    if (count !== null) assert.equal(new RegExp(`\\b${count}\\b`).test(quote) || quote.toLowerCase().includes(IN_WORDS[count] ?? "\u0000"), true, `${rule.state}: ${count}`);
  }
});

test("the figures the pages give for some states, kept as read", () => {
  const value = (code: string) => {
    const read = usSalesTaxRule(code)!.threshold;
    return read.known && read.value !== "no-state-sales-tax" ? [read.value.salesUsd, read.value.transactions, read.value.joiner] : null;
  };
  assert.deepEqual(value("CA"), [500_000, null, null]);
  assert.deepEqual(value("TX"), [500_000, null, null]);
  assert.deepEqual(value("NY"), [500_000, 100, "and"]);
  // A facilitator's own threshold where it differs from a remote seller's.
  assert.deepEqual(value("OK"), [10_000, null, null]);
  assert.deepEqual(value("CT"), [250_000, null, null]);
  for (const code of ["DE", "MT", "OR"]) {
    const read = usSalesTaxRule(code)!.threshold;
    assert.equal(read.known ? read.value : null, "no-state-sales-tax", code);
  }
});

test("states whose pages could not be read stay unknown in every field", () => {
  for (const code of ["CO", "MA", "NH", "RI", "WY", "MD"]) {
    assert.equal(fields(usSalesTaxRule(code)!).every(([, read]) => !read.known), true, code);
  }
});

test("data only: nothing reads the table yet", () => {
  const readers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && readFileSync(path, "utf8").includes("us-sales-tax-rules")) readers.push(path);
    }
  };
  for (const dir of ["app", "lib", "components"]) walk(dir);
  assert.deepEqual(readers.filter((path) => path !== join("lib", "us-sales-tax-rules.ts")), []);
});
