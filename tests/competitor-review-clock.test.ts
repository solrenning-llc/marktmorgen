import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_DAYS, overdue, type DatedFact } from "@/lib/competitor-review";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-05T00:00:00Z");
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const fact = (where: string, at: number): DatedFact => ({ where, readOn: day(at) });

test("a future source-reading date cannot certify a competitor fact as current", () => {
  const today = fact("today", NOW);
  const tomorrow = fact("tomorrow", NOW + DAY);
  const farFuture = { where: "far future", readOn: "2099-12-31" };
  assert.deepEqual(overdue([farFuture, today, tomorrow], NOW), [tomorrow, farFuture]);
});

test("the existing ninety-day boundary and real calendar validation stay exact", () => {
  const boundary = fact("exact boundary", NOW - REVIEW_DAYS * DAY);
  const stale = fact("stale", NOW - (REVIEW_DAYS + 1) * DAY);
  const today = fact("today", NOW);
  const invalid = { where: "not a calendar day", readOn: "2026-02-30" };
  assert.deepEqual(overdue([today, boundary, stale, invalid], NOW), [invalid, stale]);
  assert.equal(REVIEW_DAYS, 90);
});

test("an unknown or unrepresentable clock never suppresses required review", () => {
  const facts = [fact("today", NOW), fact("old", NOW - 120 * DAY)];
  for (const clock of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(overdue(facts, clock), [facts[1], facts[0]], String(clock));
  }
});

test("an unknown, fractional or unrepresentable window cannot certify evidence", () => {
  const facts = [fact("today", NOW), fact("old", NOW - 120 * DAY)];
  for (const window of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(overdue(facts, NOW, window), [facts[1], facts[0]], String(window));
  }
});

test("a zero-day window accepts only today's actual reading", () => {
  const yesterday = fact("yesterday", NOW - DAY);
  const today = fact("today", NOW);
  const tomorrow = fact("tomorrow", NOW + DAY);
  assert.deepEqual(overdue([tomorrow, today, yesterday], NOW, 0), [yesterday, tomorrow]);
});

test("review findings preserve the evidence and the caller's order", () => {
  const old = Object.freeze(fact("old", NOW - 120 * DAY));
  const future = Object.freeze(fact("future", NOW + DAY));
  const current = Object.freeze(fact("current", NOW));
  const facts = Object.freeze([future, current, old]);
  const input = [...facts];
  const findings = overdue(input, NOW);
  assert.deepEqual(findings, [old, future]);
  assert.deepEqual(input, facts);
  assert.equal(findings[0], old);
  assert.equal(findings[1], future);
});

test("a clock must be a number, never a date-like string or object", () => {
  const facts = [fact("today", NOW), fact("old", NOW - 120 * DAY)];
  const clocks: unknown[] = ["2026-11-05T00:00:00Z", new Date(NOW), null, Symbol("clock"), BigInt(1)];
  for (const clock of clocks) {
    assert.deepEqual(overdue(facts, clock as number), [facts[1], facts[0]]);
  }
});

test("a review window must be a number before any multiplication", () => {
  const facts = [fact("today", NOW), fact("old", NOW - 120 * DAY)];
  const windows: unknown[] = [Symbol("days"), BigInt(90), "90", null];
  for (const window of windows) {
    assert.deepEqual(overdue(facts, NOW, window as number), [facts[1], facts[0]]);
  }
});

test("unknown clocks and windows are rejected without invoking conversion hooks", () => {
  const facts = [fact("today", NOW), fact("old", NOW - 120 * DAY)];
  let conversions = 0;
  const unknown = { [Symbol.toPrimitive]() { conversions++; throw new Error("Must not coerce review evidence"); } };
  assert.deepEqual(overdue(facts, unknown as unknown as number), [facts[1], facts[0]]);
  assert.deepEqual(overdue(facts, NOW, unknown as unknown as number), [facts[1], facts[0]]);
  assert.equal(conversions, 0);
});
