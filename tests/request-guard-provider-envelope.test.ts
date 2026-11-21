import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { withinLimit, withinMonth } from "@/lib/request-guard";

// tests/aliases selects the real REST client inside request-guard. Only fetch is synthetic.
const originalFetch = globalThis.fetch;
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
let calls = 0;
beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic-request-guard-envelope";
  calls = 0;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
  if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
});
function response(body: unknown) {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://redis.invalid/pipeline");
    assert.equal(JSON.parse(String(init?.body)).length, 2);
    calls += 1;
    return Response.json(body);
  };
}

for (const [name, guard] of [
  ["withinLimit", () => withinLimit("provider-envelope", "buyer@example.test", 5, 60)],
  ["withinMonth", () => withinMonth("provider-envelope", "buyer@example.test", 5, "2026-11")],
] as const) {
  for (const [label, body] of [
    ["empty batch", []],
    ["short batch", [{ result: 1 }]],
    ["result-less envelopes", [{}, {}]],
    ["extra result", [{ result: 1 }, { result: 1 }, { result: 1 }]],
  ] as const) {
    test(`${name}: ${label} from the real REST parser refuses admission`, async () => {
      response(body);
      assert.equal(await guard(), false);
      assert.equal(calls, 1, "a write with an unknown outcome is never repeated");
    });
  }
  test(`${name}: confirmed count below the ceiling admits`, async () => {
    response([{ result: 1 }, { result: 1 }]);
    assert.equal(await guard(), true);
    assert.equal(calls, 1);
  });
  test(`${name}: confirmed count above the ceiling refuses`, async () => {
    response([{ result: 6 }, { result: 1 }]);
    assert.equal(await guard(), false);
    assert.equal(calls, 1);
  });
  test(`${name}: transport failure keeps the existing admission policy`, async () => {
    globalThis.fetch = async () => { calls += 1; throw new Error("synthetic transport failure"); };
    assert.equal(await guard(), true);
    assert.equal(calls, 1);
  });
}
