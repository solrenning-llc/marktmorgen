import test from "node:test";
import assert from "node:assert/strict";
import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";
import { PLATFORM_SUBSCRIPTION_SEARCH } from "./plan-cost-registry";

test("the real handle validator admits no JSON string below the byte floor used by the search cost bound", () => {
  const floor = PLATFORM_SUBSCRIPTION_SEARCH.serializedHandleFloorBytes;
  const bytes = (value: string) => Buffer.byteLength(JSON.stringify(value));
  const check = (value: string) => {
    if (bytes(value) < floor) assert.equal(HANDLE_PATTERN.test(value), false, JSON.stringify(value));
  };
  check("");
  // All one-code-point strings of one or two UTF-8 bytes, and every pair of
  // ASCII bytes, exhaust the strings whose quoted JSON can weigh under five.
  for (let point = 0; point < 0x800; point++) check(String.fromCodePoint(point));
  for (let first = 0; first < 0x80; first++) {
    for (let last = 0; last < 0x80; last++) check(String.fromCharCode(first, last));
  }
  assert.equal(HANDLE_PATTERN.test("abc"), true);
  assert.equal(bytes("abc"), floor);
});
