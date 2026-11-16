/**
 * E2, first pure unit: the window of a community challenge.
 * This is a new-feature contract, not a regression claim about an existing
 * challenge. No daily calendar, check-in, points, storage or public UI is added.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

type WindowState = "invalid" | "scheduled" | "active" | "ended";
type WindowRule = (startsAt: unknown, endsAt: unknown, now: unknown) => WindowState;

async function main(): Promise<void> {
  // Keep the first RED executable when the new module does not exist. A
  // computed import also lets the canonical CJS bundle exercise the actual
  // pure TypeScript module with Node, without a bundle-resolution failure.
  const moduleUrl = pathToFileURL(resolve(process.cwd(), "lib", "community-challenge-rules.ts")).href;
  let rule: unknown;
  try {
    const loaded: unknown = await import(moduleUrl);
    if (loaded !== null && typeof loaded === "object") {
      rule = Object.getOwnPropertyDescriptor(loaded, "challengeWindowState")?.value;
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  const state = (start: unknown, end: unknown, now: unknown): WindowState => {
    assert.equal(typeof rule, "function", "the new challengeWindowState contract must be implemented");
    return (rule as WindowRule)(start, end, now);
  };

  test("the new pure window rule is exported", () => {
    assert.equal(typeof rule, "function");
  });

  const ordinaryCases: [string, number, number, number, WindowState][] = [
    ["before the start is scheduled", 1000, 2000, 999, "scheduled"],
    ["the exact start is active", 1000, 2000, 1000, "active"],
    ["inside the window is active", 1000, 2000, 1500, "active"],
    ["the last millisecond before the end is active", 1000, 2000, 1999, "active"],
    ["the exact end is ended", 1000, 2000, 2000, "ended"],
    ["after the end remains ended", 1000, 2000, 2001, "ended"],
    ["equal boundaries are invalid", 1000, 1000, 1000, "invalid"],
    ["reversed boundaries are invalid", 2000, 1000, 1500, "invalid"],
    ["a one-millisecond window has an active start", 1000, 1001, 1000, "active"],
    ["a one-millisecond window ends at its end", 1000, 1001, 1001, "ended"],
    ["the epoch is a valid start", 0, 1, 0, "active"],
    ["negative zero does not invent a date restriction", -0, 1, 0, "active"],
    ["a window before the epoch is valid", -2000, -1000, -1500, "active"],
    ["a window can cross the epoch", -1000, 1000, 0, "active"],
  ];
  for (const [name, start, end, now, expected] of ordinaryCases) {
    test(name, () => assert.equal(state(start, end, now), expected));
  }

  const dateEdge = 8_640_000_000_000_000;
  const edgeCases: [string, number, number, number, WindowState][] = [
    ["the earliest representable date is a valid start", -dateEdge, -dateEdge + 1, -dateEdge, "active"],
    ["the latest representable date is a valid end", dateEdge - 1, dateEdge, dateEdge - 1, "active"],
    ["the latest representable date can be the current ended instant", dateEdge - 1, dateEdge, dateEdge, "ended"],
    ["a representable current instant before a far-future start is scheduled", dateEdge - 1, dateEdge, -dateEdge, "scheduled"],
    ["the full representable window stays active without duration overflow", -dateEdge, dateEdge, 0, "active"],
  ];
  for (const [name, start, end, now, expected] of edgeCases) {
    test(name, () => assert.equal(state(start, end, now), expected));
  }

  const invalid: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["a numeric string", "1000"],
    ["an ISO date string", "2026-11-06T00:00:00.000Z"],
    ["an empty string", ""],
    ["true", true],
    ["false", false],
    ["an empty array", []],
    ["a singleton array", [1000]],
    ["a plain object", {}],
    ["a Date object", new Date(1000)],
    ["a boxed number", Object(1000)],
    ["a bigint", BigInt(1000)],
    ["a symbol", Symbol("synthetic time")],
    ["a positive fraction", 1000.5],
    ["a negative fraction", -1000.5],
    ["NaN", NaN],
    ["positive infinity", Infinity],
    ["negative infinity", -Infinity],
    ["one millisecond above the Date range", dateEdge + 1],
    ["one millisecond below the Date range", -dateEdge - 1],
    ["an unsafe positive integer", Number.MAX_SAFE_INTEGER + 1],
    ["an unsafe negative integer", Number.MIN_SAFE_INTEGER - 1],
  ];
  for (const [name, value] of invalid) {
    test(`reject ${name} as the start without coercion`, () => assert.equal(state(value, 2000, 1500), "invalid"));
    test(`reject ${name} as the end without coercion`, () => assert.equal(state(1000, value, 1500), "invalid"));
    test(`reject ${name} as the current instant without coercion`, () => assert.equal(state(1000, 2000, value), "invalid"));
  }

  test("objects are rejected without invoking conversion hooks", () => {
    let conversions = 0;
    const coercible = {
      [Symbol.toPrimitive]() { conversions += 1; throw new Error("conversion must not run"); },
      valueOf() { conversions += 1; throw new Error("conversion must not run"); },
    };
    assert.equal(state(coercible, 2000, 1500), "invalid");
    assert.equal(state(1000, coercible, 1500), "invalid");
    assert.equal(state(1000, 2000, coercible), "invalid");
    assert.equal(conversions, 0);
  });

  test("the supplied instant alone determines state, with no clock mutation", () => {
    const before = Date.now;
    Date.now = () => { throw new Error("the ambient clock must not be read"); };
    try {
      assert.deepEqual([state(1000, 2000, 999), state(1000, 2000, 1000), state(1000, 2000, 2000)], ["scheduled", "active", "ended"]);
    } finally {
      Date.now = before;
    }
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
