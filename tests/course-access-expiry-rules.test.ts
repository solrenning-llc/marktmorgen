import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type ExpiryState = "unspecified" | "active" | "expired" | "invalid";
type ExpiryRule = (expiresAt: unknown, now: unknown) => ExpiryState;

// Computed import keeps the new-feature RED executable before the module exists.
// Only that missing file is tolerated; module evaluation errors must surface.
const moduleUrl = pathToFileURL(resolve("lib/course-access-expiry-rules.ts")).href;
const expiryModule = import(moduleUrl).catch((error: unknown) => {
  if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND"
    && "url" in error && error.url === moduleUrl) return {};
  throw error;
});

async function rule(): Promise<ExpiryRule> {
  const loaded = await expiryModule;
  const candidate: unknown = Reflect.get(loaded, "courseAccessExpiryState");
  assert.ok(typeof candidate === "function", "Missing courseAccessExpiryState export: new expiry-state feature is not implemented");
  return candidate as ExpiryRule;
}

const maxTimestamp = 8_640_000_000_000_000;
const invalidTimestamps: unknown[] = [
  undefined, null, "0", "2026-11-06T00:00:00.000Z", "", true, false,
  NaN, Infinity, -Infinity, 0.5, -0.5, maxTimestamp + 1, -maxTimestamp - 1,
  Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, BigInt(0), Symbol("timestamp"),
  [], [0], {}, new Date(0), new Number(0),
];

test("known absent expiry is unspecified with a valid explicit clock", async () => {
  const state = await rule();
  for (const now of [-maxTimestamp, -1, 0, maxTimestamp]) {
    assert.equal(state(undefined, now), "unspecified");
    assert.equal(state(null, now), "unspecified");
  }
});

test("invalid clock is rejected even when expiry is unspecified", async () => {
  const state = await rule();
  for (const now of invalidTimestamps) {
    assert.equal(state(undefined, now), "invalid");
    assert.equal(state(null, now), "invalid");
  }
});

test("expiry later than now is active as an expiry state only", async () => {
  const state = await rule();
  assert.equal(state(1_800_000_000_001, 1_800_000_000_000), "active");
  assert.equal(state(1, 0), "active");
});

test("expiry exactly at now is expired", async () => {
  const state = await rule();
  for (const time of [-maxTimestamp, -1, 0, 1, maxTimestamp]) {
    assert.equal(state(time, time), "expired");
  }
});

test("expiry earlier than now is expired", async () => {
  const state = await rule();
  assert.equal(state(1_800_000_000_000, 1_800_000_000_001), "expired");
  assert.equal(state(0, 1), "expired");
});

test("zero and negative timestamps retain their chronological meaning", async () => {
  const state = await rule();
  assert.equal(state(0, -1), "active");
  assert.equal(state(-1, -2), "active");
  assert.equal(state(-2, -1), "expired");
  assert.equal(state(-1, 0), "expired");
  assert.equal(state(-0, 0), "expired");
});

test("both exact inclusive timestamp endpoints are accepted", async () => {
  const state = await rule();
  assert.equal(state(-maxTimestamp + 1, -maxTimestamp), "active");
  assert.equal(state(-maxTimestamp, -maxTimestamp + 1), "expired");
  assert.equal(state(maxTimestamp, maxTimestamp - 1), "active");
  assert.equal(state(maxTimestamp - 1, maxTimestamp), "expired");
  assert.equal(state(maxTimestamp, -maxTimestamp), "active");
});

test("wrong-type, nonfinite, fractional and out-of-range expiry is invalid", async () => {
  const state = await rule();
  for (const expiry of invalidTimestamps.filter((value) => value !== null && value !== undefined)) {
    assert.equal(state(expiry, 0), "invalid");
  }
});

test("wrong-type, nonfinite, fractional and out-of-range clocks are invalid", async () => {
  const state = await rule();
  for (const now of invalidTimestamps) assert.equal(state(0, now), "invalid");
});

test("objects are not coerced or inspected as timestamps", async () => {
  const state = await rule();
  let coercions = 0;
  const object = {
    [Symbol.toPrimitive]() { coercions++; throw new Error("must not coerce"); },
    valueOf() { coercions++; throw new Error("must not coerce"); },
    toString() { coercions++; throw new Error("must not coerce"); },
  };
  assert.equal(state(object, 0), "invalid");
  assert.equal(state(null, object), "invalid");
  assert.equal(state(0, object), "invalid");
  assert.equal(coercions, 0);
});

test("explicit clocks determine state consistently without a wall-clock default", async () => {
  const state = await rule();
  assert.equal(state(100, 99), "active");
  assert.equal(state(100, 100), "expired");
  assert.equal(state(100, 99), "active");
  assert.equal(state(100, undefined), "invalid");
});
