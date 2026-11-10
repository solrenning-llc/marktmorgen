import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
