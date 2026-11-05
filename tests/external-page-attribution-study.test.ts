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
  assert.match(text, /no consent.*no request.*no storage/is);
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
  assert.match(text, /no finite launch budget.*verified supplier and infrastructure costs/is);
});

test("the queue records the study once in Group B at MQ2 criterion f", () => {
  const queue = readQueue();
  assert.equal((queue.match(/641\. \[EXT1\]/g) ?? []).length, 1);
  assert.ok(queue.includes("641 [EXT1] | B"));
  assert.match(queue, /641 \[EXT1\][^\n]*criterion \(f\)|641 \[EXT1\][^\n]*critério \(f\)/i);
  assert.match(queue, /559 \[CM3\][^\n]*, 641 \[EXT1\], 40 \[G2\]/);
});
