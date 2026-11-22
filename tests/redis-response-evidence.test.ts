import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
// Relative import deliberately exercises the real REST client, not the Redis stand-in.
import { redisPipeline, redisPipelineBase64 } from "../lib/redis";
import { UnknownReplyError } from "../lib/redis-reply";

const fetchBefore = globalThis.fetch;
const envBefore = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
let calls: RequestInit[] = [];
beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic-redis-response-fixture";
  calls = [];
});
afterEach(() => {
  globalThis.fetch = fetchBefore;
  for (const [key, value] of [["UPSTASH_REDIS_REST_URL", envBefore.url], ["UPSTASH_REDIS_REST_TOKEN", envBefore.token]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
});
function answer(value: unknown, status = 200) {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://redis.invalid/pipeline");
    calls.push(init!);
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  };
}

for (const [name, pipeline] of [["plain", redisPipeline], ["base64", redisPipelineBase64]] as const) {
  for (const [label, body] of [
    ["missing first reply", []],
    ["missing second reply", [{ result: 1 }]],
    ["extra reply", [{ result: 1 }, { result: 2 }, { result: 3 }]],
    ["missing result", [{}, { result: 2 }]],
    ["missing later result", [{ result: 1 }, {}]],
    ["null entry", [null, { result: 2 }]],
    ["array entry", [[], { result: 2 }]],
    ["boolean error", [{ error: false }, { result: 2 }]],
    ["empty error", [{ error: "" }, { result: 2 }]],
    ["conflicting result and error", [{ result: 1, error: null }, { result: 2 }]],
    ["extra success field", [{ result: 1, unconfirmed: true }, { result: 2 }]],
    ["non-array body", {}],
  ] as const) test(`${name}: ${label} cannot become an acknowledged batch`, async () => {
    answer(body);
    // An answer out of shape is unknown (UnknownReplyError), so a route that tells it apart says "unavailable" (503),
    // never a server error (Claude 5 on #2509, LOW 2).
    await assert.rejects(pipeline([["INCR", "fixture:first"], ["INCR", "fixture:second"]]), UnknownReplyError);
    assert.equal(calls.length, 1, "an uncertain write is never replayed");
  });

  test(`${name}: complete replies preserve explicit absence, zero, order and nested values`, async () => {
    const values = [null, 0, "OK", ["field", null, ["nested", 4]], "", "YWJj"];
    answer(values.map(result => ({ result })));
    assert.deepEqual(await pipeline(values.map((_, index) => ["GET", `fixture:${index}`])), values);
    assert.equal(calls.length, 1);
    const headers = new Headers(calls[0].headers);
    assert.equal(headers.get("Upstash-Encoding"), name === "base64" ? "base64" : null);
    assert.equal(calls[0].cache, "no-store");
    assert.ok(calls[0].signal instanceof AbortSignal);
  });

  test(`${name}: a real Redis error rejects the complete batch`, async () => {
    answer([{ result: "OK" }, { error: "WRONGTYPE fixture" }]);
    await assert.rejects(pipeline([["SET", "fixture:a", "v"], ["HGET", "fixture:a", "f"]]), (error: unknown) => error instanceof Error && /Redis error/.test(error.message) && !(error instanceof UnknownReplyError));
    assert.equal(calls.length, 1);
  });

  test(`${name}: HTTP and invalid JSON failures do not retry`, async () => {
    answer({ error: "fixture unavailable" }, 503);
    await assert.rejects(pipeline([["GET", "fixture:a"]]));
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => { calls.push({}); return new Response("incomplete-json"); };
    await assert.rejects(pipeline([["GET", "fixture:a"]]));
    assert.equal(calls.length, 2);
  });
}
