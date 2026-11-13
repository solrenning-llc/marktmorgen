import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailUsageSummary } from "@/components/email-usage-summary";
import { confirmedEmailUsage } from "@/lib/email-usage-summary";

const page = readFileSync("app/studio/email/page.tsx", "utf8");

test("the email page reads its existing counter exactly instead of inventing zero", () => {
  assert.match(page, /usedThisMonthExact\(store\.listId,/);
  assert.doesNotMatch(page, /\busedThisMonth\(/);
});

test("email usage is before the composer for every viewport", () => {
  const usage = page.indexOf("<EmailUsageSummary");
  assert.ok(usage >= 0, "the email page has a visible usage summary");
  assert.ok(usage < page.indexOf("<EmailStudio"), "usage precedes the composing interface");
});

test("an unconfirmed counter does not enter the composer as a known month", () => {
  assert.match(page, /monthKnown=\{used !== null\}/);
});

const render = (used: number | null, allowance = 10_000) =>
  renderToStaticMarkup(createElement(EmailUsageSummary, { used, allowance }));

test("the visible text preserves the supplied monthly count and limit", () => {
  for (const [used, limit] of [[0, 10_000], [2_345, 10_000], [10_000, 10_000], [12_345, 10_000], [0, 0]]) {
    const html = render(used, limit);
    assert.ok(html.includes(`${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} this month.`));
    assert.match(html, /<h2[^>]*id="email-usage-title"/);
    assert.match(html, /aria-labelledby="email-usage-title"/);
    assert.match(html, /One-off list emails and sequences share this limit/);
  }
});

test("unknown or invalid use never becomes zero, free capacity or a progress value", () => {
  for (const used of [null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const html = render(used);
    assert.match(html, /role="status"/);
    assert.match(html, /could not be loaded/);
    assert.match(html, /Reload this page/);
    assert.match(html, /10,000/);
    assert.doesNotMatch(html, /progressbar|aria-valuenow|0 of 10,000|NaN|Infinity/);
  }
});

test("unknown limits are not presented as a verified monthly capacity", () => {
  for (const limit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const html = render(0, limit);
    assert.match(html, /threshold could not be verified/);
    assert.doesNotMatch(html, /progressbar|aria-valuenow|0 of/);
  }
});

test("the summary has no opening pixel, network operation or automatic refresh", () => {
  const html = render(2_345);
  assert.doesNotMatch(html, /<img|<iframe|<script|http:|https:|<button|<form/);
  const component = readFileSync("components/email-usage-summary.tsx", "utf8");
  assert.doesNotMatch(component, /fetch\(|setInterval\(|setTimeout\(|useEffect\(/);
});

test("only confirmed whole counts reach the page and the composer", () => {
  for (const value of [null, undefined, "0", "2", false, {}, [], -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(confirmedEmailUsage(value), null);
  }
  for (const value of [0, 1, 2_345, Number.MAX_SAFE_INTEGER]) assert.equal(confirmedEmailUsage(value), value);
});
