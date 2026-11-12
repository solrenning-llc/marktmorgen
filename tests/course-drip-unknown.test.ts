/**
 * A module's wait that does not read (lib/course.ts, parseModule) never opens it early: unknown is not "no wait"
 * (CX-123 rule 24). A saved course whose dripDays is not a whole number of days from 0 to MAX_DRIP_DAYS (a string
 * that is not a number, null, a fraction, a negative, a number past the cap, or no field at all) keeps the module
 * closed for the longest wait a creator can set, never opens it at once; a wait that reads stays exactly as saved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DRIP_DAYS, emptyCourse, isOpen, parseCourse } from "@/lib/course";

const saved = (dripDays: unknown, keep = true) => {
  const course = emptyCourse("0123456789abcdef0123456789abcdef");
  const unit: Record<string, unknown> = { ...course.modules[0], id: "abcdefabcdef" };
  if (keep) unit.dripDays = dripDays;
  else delete unit.dripDays;
  return JSON.stringify({ ...course, modules: [unit] });
};

const joined = 1_800_000_000;

test("a wait that does not read keeps the module closed, never opens it at once", () => {
  for (const [label, raw, keep] of [
    ["not a number", "soon", true],
    ["null (NaN written as JSON)", null, true],
    ["a fraction", 1.5, true],
    ["a negative", -3, true],
    ["past the cap", MAX_DRIP_DAYS + 1, true],
    ["an object", { days: 7 }, true],
    ["no field", undefined, false],
  ] as const) {
    const course = parseCourse(saved(raw, keep));
    assert.ok(course, label);
    const unit = course.modules[0];
    assert.equal(unit.dripDays, MAX_DRIP_DAYS, `${label}: held at the longest wait`);
    assert.equal(isOpen(course, unit, joined, joined + 60), false, `${label}: closed a minute after joining`);
    assert.equal(isOpen(course, unit, joined, joined + 30 * 86_400), false, `${label}: closed a month after joining`);
  }
});

test("a wait that reads stays exactly as saved", () => {
  for (const days of [0, 1, 7, MAX_DRIP_DAYS]) assert.equal(parseCourse(saved(days))!.modules[0].dripDays, days, String(days));
  // Typed as text and kept as text by an older writer: still a whole number, still read.
  assert.equal(parseCourse(saved("7"))!.modules[0].dripDays, 7);
  const open = parseCourse(saved(0))!;
  assert.equal(isOpen(open, open.modules[0], joined, joined + 1), true, "no wait opens at once");
});
