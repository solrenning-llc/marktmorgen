import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readStudy = () => readFileSync("docs/external-page-attribution-study.md", "utf8");
const readQueue = () => readFileSync("docs/codex-queue.md", "utf8");

test("the study is dated, source-bound and explicitly precedes implementation", () => {
  const text = readStudy();
  for (const fact of [
    "November 5, 2026",
    "Study only",
    "before implementation",
    "Official source",
    "Retrieved November 5, 2026",
    "without a Marktmorgen checkout",
  ]) assert.ok(text.includes(fact), fact);
  assert.match(text, /no script, endpoint, account, vendor setup, acceptance of terms or production request/i);
});

test("consent and browser refusal happen before every optional request or write", () => {
  const text = readStudy();
  for (const fact of [
    "before loading the script",
    "before the first network request",
    "Global Privacy Control",
    "unknown country",
    "refusal is as easy as acceptance",
    "withdrawal",
  ]) assert.ok(text.includes(fact), fact);
  assert.match(text, /no consent[\s\S]*no request[\s\S]*no storage/i);
});

test("the proposed event minimizes data and does not create a person profile", () => {
  const text = readStudy();
  for (const fact of [
    "allowlisted HTTPS origin",
    "normalized path category",
    "campaign tags",
    "full query string",
    "full referrer",
    "IP address",
    "email",
    "persistent cross-site identifier",
    "infrastructure logs",
  ]) assert.ok(text.includes(fact), fact);
  assert.match(text, /must not (?:send|store)[\s\S]*full query string[\s\S]*full referrer[\s\S]*IP address/i);
});

test("campaign tag values reject personal data before normalization", () => {
  const text = readStudy();
  for (const fact of [
    "Campaign tag values must reject personal data",
    "before any normalization",
    "email-like",
    "name-like",
    "high-entropy identifier",
    "reject the whole event",
  ]) assert.ok(text.includes(fact), fact);
  assert.match(text, /must not (?:strip|hash)[^.]{0,160}(?:email|personal data)[^.]{0,160}(?:keep|retain|store)/i);
});

test("the official-source ledger records current versions, dates and URLs", () => {
  const text = readStudy();
  assert.ok(text.includes("Version 2.0 adopted October 7, 2024; final page October 16, 2024"));
  assert.ok(text.includes("Last reviewed October 5, 2026"));
  assert.ok(text.includes("https://docs.whop.com/third-party-integrations/embedded-checkouts/attribute-affiliates-embedded-checkout"));
  assert.doesNotMatch(text, /https:\/\/docs\.whop\.com\/affiliates\/attribution/);
  assert.deepEqual(text.split("\n").filter((line) => /[ \t]+$/.test(line)), []);
});

test("measurement language separates accepted events, visits, people and sales", () => {
  const text = readStudy();
  for (const fact of [
    "accepted page event",
    "not a unique person",
    "not a sale",
    "not revenue attribution",
    "unknown",
    "Marktmorgen checkout",
    "buyer answer",
  ]) assert.ok(text.includes(fact), fact);
  assert.match(text, /never label.*unique visitor/i);
});

test("the study reuses existing boundaries and rejects a second pixel center", () => {
  const text = readStudy();
  for (const fact of [
    "docs/ht10-pixels-attribution.md",
    "lib/attribution-rules.ts",
    "lib/embed-sdk.ts",
    "lib/embed-sites.ts",
    "lib/traffic.ts",
    "single canonical pixel and attribution center",
    "no vendor pixel IDs",
  ]) assert.ok(text.includes(fact), fact);
});

test("cost, abuse, retention and deletion remain bounded before activation", () => {
  const text = readStudy();
  for (const fact of [
    "unknown, never zero",
    "prepaid allowance",
    "before accepting the event",
    "per-origin rate limit",
    "payload byte limit",
    "retention ceiling",
    "deletion",
    "refund",
    "disabled by default",
  ]) assert.ok(text.includes(fact), fact);
  assert.match(text, /no finite launch budget[\s\S]*verified supplier and infrastructure costs/i);
});

test("the queue extends existing item 630 resource 36 once in Group B at MQ2 criterion f", () => {
  const queue = readQueue();
  assert.equal((queue.match(/630\. \[HN6\]/g) ?? []).length, 1);
  assert.ok(queue.includes("630 [HN6](36) | B"));
  assert.match(queue, /630 \[HN6\]\(36\)[^\n]*criterion \(f\)|630 \[HN6\]\(36\)[^\n]*critério \(f\)/i);
  assert.match(queue, /630 \[HN6\]\(36\)[\s\S]*docs\/external-page-attribution-study\.md/);
  assert.doesNotMatch(queue, /641\. \[EXT1\]/);
});
