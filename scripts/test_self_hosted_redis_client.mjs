// Synthetic CI only: exercise the application's actual HTTP client against
// test_self_hosted_redis_http.py and disposable loopback Redis. No provider calls.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

assert.equal(process.env.MARKTMORGEN_REDIS_INTEGRATION, "1");
const endpoint = new URL(process.env.MARKTMORGEN_SYNTHETIC_REDIS_URL ?? "");
assert.equal(endpoint.protocol, "http:");
assert.equal(endpoint.hostname, "127.0.0.1");
assert.match(endpoint.port, /^[1-9][0-9]{0,4}$/);
assert.equal(endpoint.pathname, "/");
assert.equal(endpoint.search + endpoint.hash + endpoint.username + endpoint.password, "");
const token = process.env.MARKTMORGEN_SYNTHETIC_REDIS_TOKEN;
const prefix = process.env.MARKTMORGEN_SYNTHETIC_REDIS_PREFIX;
assert.match(token ?? "", /^[A-Za-z0-9_-]{43}$/);
assert.match(prefix ?? "", /^marktmorgen:integration:sv4-http:[0-9a-f]{32}:$/);
const redisUrl = new URL("../lib/redis.ts", import.meta.url).href;
const timeoutUrl = new URL("../lib/fetch-timeout.ts", import.meta.url).href;
// Node 24 strips types from the real sources. Resolve only their existing
// repository alias; no copied implementation or MemoryRedis replaces them.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/fetch-timeout" && context.parentURL === redisUrl) {
      return { url: timeoutUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[name];
process.env.UPSTASH_REDIS_REST_URL = endpoint.origin;
process.env.UPSTASH_REDIS_REST_TOKEN = token;
const nativeFetch = globalThis.fetch;
let requests = 0;
let loseNextAck = false;
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), endpoint.origin + "/pipeline");
  assert.equal(init?.method, "POST");
  assert.equal(init?.cache, "no-store");
  assert.ok(init?.signal instanceof AbortSignal);
  const commands = JSON.parse(init.body);
  // Every command here targets this run's own synthetic namespace.
  for (const command of commands) assert.ok(command[1].startsWith(prefix));
  requests++;
  const headers = new Headers(init.headers);
  if (loseNextAck) {
    loseNextAck = false;
    headers.set("X-Fixture-Lose-Ack", "1");
  }
  return nativeFetch(input, { ...init, headers });
};
try {
  const { redisPipeline, isRedisConfigured, redisOutcomeOf } = await import(redisUrl);
  const outcomeOf = async (work) => {
    try {
      await work;
    } catch (error) {
      return redisOutcomeOf(error);
    }
    assert.fail("the call was expected to throw");
  };
  const { withCutoff } = await import(timeoutUrl);
  assert.equal(isRedisConfigured(), true);
  const key = (name) => prefix + "node-" + name;

  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  assert.equal(isRedisConfigured(), false);
  const beforeMissingConfig = requests;
  await assert.rejects(redisPipeline([["INCR", key("counter")]]), /Redis is not configured/);
  assert.deepEqual(await outcomeOf(redisPipeline([["INCR", key("counter")]])), { kind: "not-sent" });
  assert.equal(requests, beforeMissingConfig);
  process.env.UPSTASH_REDIS_REST_TOKEN = "invalid-synthetic-token";
  await assert.rejects(redisPipeline([["INCR", key("counter")]]), /status 401/);
  // An HTTP status is never read as a refusal (what each Upstash status means is not read in lib/redis.ts).
  assert.deepEqual(await outcomeOf(redisPipeline([["INCR", key("counter")]])), { kind: "maybe-applied" });
  process.env.UPSTASH_REDIS_REST_TOKEN = token;
  assert.deepEqual(await redisPipeline([["GET", key("counter")]]), [null]);
  console.log("PASS: actual Redis client rejects missing/invalid configuration without mutation");

  const value = "ação — 日本語 / @creator | \\n";
  assert.deepEqual(await redisPipeline([
    ["SET", key("value"), value], ["GET", key("value")], ["GET", key("missing")],
  ]), ["OK", value, null]);
  assert.deepEqual(await redisPipeline([
    ["HSET", key("hash"), "field", "value"], ["PTTL", key("hash")],
    ["PEXPIRE", key("value"), 60000],
  ]), [1, -1, 1]);
  const [remainingBefore] = await redisPipeline([["PTTL", key("value")]]);
  const [read, remainingAfter] = await redisPipeline([
    ["GET", key("value")], ["PTTL", key("value")],
  ]);
  assert.equal(read, value);
  assert.ok(remainingAfter > 0 && remainingAfter <= remainingBefore);
  console.log("PASS: actual Redis client preserves ordered Unicode/null results and TTLs");

  const beforePartial = requests;
  const partial = redisPipeline([["GET", key("hash")], ["INCR", key("counter")]]);
  await assert.rejects(partial, /Redis error: Synthetic Redis command error/);
  // Redis refused the GET and applied the INCR: a pipeline is not a transaction, and each answer says which.
  assert.deepEqual(await outcomeOf(partial), {
    kind: "refused",
    answers: [{ applied: false, error: "Synthetic Redis command error" }, { applied: true, result: 1 }],
  });
  assert.equal(requests, beforePartial + 1);
  assert.deepEqual(await redisPipeline([["GET", key("counter")]]), ["1"]);
  console.log("PASS: actual Redis client surfaces partial pipeline error without replay");

  const beforeUnknown = requests;
  loseNextAck = true;
  const lostAck = redisPipeline([["INCR", key("ack")]]);
  await assert.rejects(lostAck, TypeError);
  // The write landed though its answer was lost: never "not-sent" or "refused".
  assert.deepEqual(await outcomeOf(lostAck), { kind: "maybe-applied" });
  assert.equal(loseNextAck, false);
  assert.equal(requests, beforeUnknown + 1);
  assert.deepEqual(await redisPipeline([["GET", key("ack")]]), ["1"]);
  console.log("PASS: actual Redis client leaves committed lost-ACK result unknown without replay");

  const beforeCutoff = requests;
  await assert.rejects(
    withCutoff(Date.now() - 1, () => redisPipeline([["INCR", key("cutoff")]])),
    /fetch failed/,
  );
  assert.deepEqual(await outcomeOf(withCutoff(Date.now() - 1, () => redisPipeline([["INCR", key("cutoff")]]))), { kind: "not-sent" });
  assert.equal(requests, beforeCutoff);
  assert.deepEqual(await redisPipeline([["GET", key("cutoff")]]), [null]);
  console.log("PASS: actual timeout helper rejects expired work before any HTTP request");

  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.KV_REST_API_URL = endpoint.origin + "///";
  process.env.KV_REST_API_TOKEN = token;
  assert.equal(isRedisConfigured(), true);
  assert.deepEqual(await redisPipeline([["GET", key("value")]]), [value]);
  console.log("PASS: actual Redis client retains existing KV aliases and URL normalization");
} finally {
  globalThis.fetch = nativeFetch;
  hooks.deregister();
}
