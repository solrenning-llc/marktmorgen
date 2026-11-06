/** Actual API-key helpers and endpoints; only Redis replies and records are synthetic. */
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { MAX_KEYS, makeKey, resolveKey, revokeKey } from "@/lib/api-keys";
import { apiStore, apiWriter } from "@/lib/api-guard";
import { POST } from "@/app/api/store/api-keys/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import "./q-api-key-revoke.proof";
import "./q-api-key-resolve.proof";

const sid = "a".repeat(32);
const original = redis.pipeline.bind(redis);
const origin = "https://marktmorgen.com";
async function key() {
  redis.clear();
  const made = await makeKey(sid, "Synthetic evidence");
  assert.equal(made.ok, true);
  if (!made.ok) throw new Error("Synthetic setup failed");
  return made;
}

for (const [label, mutate] of [
  ["missing envelope", () => []],
  ["extra slot", (r: unknown[]) => [...r, null]],
  ["hole", () => new Array(4)],
  ["undefined hold", (r: unknown[]) => [r[0], undefined, r[2], r[3]]],
  ["object listed record", (r: unknown[]) => [{}, r[1], r[2], r[3]]],
  ["invalid listed JSON", (r: unknown[]) => ["broken", r[1], r[2], r[3]]],
  ["numeric hold", (r: unknown[]) => [r[0], 0, r[2], r[3]]],
  ["unknown hold text", (r: unknown[]) => [r[0], "unread", r[2], r[3]]],
  ["object team", (r: unknown[]) => [r[0], r[1], r[2], {}]],
  ["numeric last use", (r: unknown[]) => [r[0], r[1], 0, r[3]]],
  ["invalid last use", (r: unknown[]) => [r[0], r[1], "unread", r[3]]],
  ["invalid team JSON", (r: unknown[]) => [r[0], r[1], r[2], "broken"]],
  ["invalid rule type", (r: unknown[]) => [r[0], r[1], r[2], '{"members":[],"invites":[],"requireTwoStep":"true"}']],
  ["null member under a required rule", (r: unknown[]) => [r[0], r[1], r[2], '{"members":[null],"invites":[],"requireTwoStep":true}']],
  ["null invite under a required rule", (r: unknown[]) => [r[0], r[1], r[2], '{"members":[],"invites":[null],"requireTwoStep":true}']],
] as const) {
  test(`unknown resolution ${label} refuses read and write before admission`, async () => {
    const made = await key();
    let intercepted = 0;
    let later = 0;
    redis.pipeline = async (commands) => {
      if (commands.length === 4 && commands[0]?.[1] === `nl:api:keys:${sid}`) {
        intercepted += 1;
        return mutate(await original(commands));
      }
      if (intercepted && commands[0]?.[0] !== "GET") later += 1;
      return original(commands);
    };
    try {
      for (const admit of [apiStore, apiWriter]) {
        const response = await admit(new Request(`${origin}/api/v1/store`, { headers: { authorization: `Bearer ${made.key}` } }));
        assert.ok(response instanceof Response);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error, "unavailable");
      }
      assert.equal(intercepted, 2);
      assert.equal(later, 0, "no rate, allowance or touch operation after unknown evidence");
    } finally { redis.pipeline = original; }
  });
}

for (const bad of [-1, 2, "1"]) {
  test(`a one-key deletion receipt of ${typeof bad}:${bad} cannot confirm revocation`, async () => {
    const made = await key();
    redis.pipeline = async (commands) => commands.length === 4 && commands[0]?.[0] === "DEL" ? [bad, 1, 0, 0] : original(commands);
    let gone: boolean;
    try { gone = await revokeKey(sid, made.made.id); } finally { redis.pipeline = original; }
    assert.equal(gone, false);
    assert.equal((await resolveKey(made.key))?.sid, sid);
    assert.equal(await revokeKey(sid, made.made.id), true);
    assert.equal(await resolveKey(made.key), null);
  });
}

test("an applied revocation with a lost receipt stays unconfirmed without automatic replay", async () => {
  const made = await key();
  let applied = 0;
  redis.pipeline = async (commands) => {
    const reply = await original(commands);
    if (commands.length === 4 && commands[0]?.[0] === "DEL") { applied += 1; return []; }
    return reply;
  };
  let gone: boolean;
  try { gone = await revokeKey(sid, made.made.id); } finally { redis.pipeline = original; }
  assert.equal(gone, false);
  assert.equal(applied, 1);
  assert.equal(await resolveKey(made.key), null, "the write really landed; its missing receipt proves neither outcome");
});

test("unknown initial lookup is unavailable; confirmed missing key remains unauthorized", async () => {
  const made = await key();
  redis.pipeline = async (commands) => commands.length === 1 && commands[0]?.[0] === "GET" && String(commands[0]?.[1]).startsWith("nl:api:k:") ? [] : original(commands);
  try {
    const result = await apiStore(new Request(`${origin}/api/v1/store`, { headers: { authorization: `Bearer ${made.key}` } }));
    assert.ok(result instanceof Response);
    assert.equal(result.status, 503);
  } finally { redis.pipeline = original; }
  await revokeKey(sid, made.made.id);
  const missing = await apiStore(new Request(`${origin}/api/v1/store`, { headers: { authorization: `Bearer ${made.key}` } }));
  assert.ok(missing instanceof Response);
  assert.equal(missing.status, 401);
});

test("unknown revocation remains retryable in the actual studio endpoint", async () => {
  redis.clear();
  const owner = "api-proof@example.test";
  await claimHandle(owner, "qapiproof", "Synthetic API", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_QApiProof", subscriptionId: "sub_QApiProof", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const made = await makeKey(store.sid, "Synthetic endpoint evidence");
  if (!made.ok) throw new Error("Synthetic setup failed");
  const session = await openSession(owner);
  const call = () => POST(new NextRequest(`${origin}/api/store/api-keys?store=${store.sid}`, {
    method: "POST", headers: { "content-type": "application/json", origin, host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` },
    body: JSON.stringify({ action: "revoke", id: made.made.id }),
  }));
  let injected = 0;
  redis.pipeline = async (commands) => {
    if (commands.length === 4 && commands[0]?.[0] === "DEL" && String(commands[0]?.[1]).startsWith("nl:api:k:")) { injected += 1; return []; }
    return original(commands);
  };
  let response: Response;
  try { response = await call(); } finally { redis.pipeline = original; }
  assert.equal(injected, 1);
  assert.equal((await resolveKey(made.key))?.sid, store.sid);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "revoke_unconfirmed" });
  const retried = await call();
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).ok, true);
  assert.equal(await resolveKey(made.key), null);
});

for (const outcome of ["healthy", "unapplied", "applied", "thrown"] as const) {
  test(`a creation race reports the actual rollback evidence: ${outcome}`, async () => {
    redis.clear();
    for (let i = 0; i < MAX_KEYS - 1; i += 1) assert.equal((await makeKey(sid, `Synthetic seed ${i}`)).ok, true);
    let raced = false;
    let rollbacks = 0;
    const wrapped: typeof redis.pipeline = async (commands) => {
      if (!raced && commands.length === 1 && commands[0]?.[0] === "HLEN" && commands[0]?.[1] === `nl:api:keys:${sid}`) {
        const read = await original(commands);
        raced = true;
        // A real second writer fills the last place after the first read.
        redis.pipeline = original;
        try { assert.equal((await makeKey(sid, "Synthetic concurrent key")).ok, true); }
        finally { redis.pipeline = wrapped; }
        return read;
      }
      if (commands.length === 2 && commands[0]?.[0] === "DEL" && commands[1]?.[0] === "HDEL") {
        rollbacks += 1;
        if (outcome === "unapplied") return [];
        if (outcome === "thrown") throw new Error("Synthetic rollback transport failure");
        const reply = await original(commands);
        return outcome === "applied" ? [] : reply;
      }
      return original(commands);
    };
    redis.pipeline = wrapped;
    let result: Awaited<ReturnType<typeof makeKey>>;
    try { result = await makeKey(sid, "Synthetic racing key"); }
    finally { redis.pipeline = original; }
    assert.equal(raced, true);
    assert.equal(rollbacks, 1, "an unknown acknowledgement never triggers automatic replay");
    assert.deepEqual(result, { ok: false, reason: outcome === "healthy" ? "full" : "make_unconfirmed" });
    const [count] = await original([["HLEN", `nl:api:keys:${sid}`]]);
    assert.equal(count, outcome === "unapplied" || outcome === "thrown" ? MAX_KEYS + 1 : MAX_KEYS);
  });
}

test("the creation endpoint never says nothing changed after an unknown rollback", async () => {
  redis.clear();
  const owner = "api-rollback@example.test";
  await claimHandle(owner, "qrollback", "Synthetic rollback", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_QRollback", subscriptionId: "sub_QRollback", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const session = await openSession(owner);
  let rollbacks = 0;
  redis.pipeline = async (commands) => {
    if (commands.length === 2 && commands[0]?.[0] === "DEL" && commands[1]?.[0] === "HDEL") { rollbacks += 1; return []; }
    const reply = await original(commands);
    return commands.length === 3 && commands[0]?.[0] === "SET" && commands[1]?.[0] === "HSET" && commands[2]?.[0] === "HLEN" ? [reply[0], reply[1], undefined] : reply;
  };
  let response: Response;
  try {
    response = await POST(new NextRequest(`${origin}/api/store/api-keys?store=${store.sid}`, {
      method: "POST", headers: { "content-type": "application/json", origin, host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ action: "make", name: "Synthetic uncertain creation" }),
    }));
  } finally { redis.pipeline = original; }
  assert.equal(rollbacks, 1);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "make_unconfirmed" });
  assert.equal((await original([["HLEN", `nl:api:keys:${store.sid}`]]))[0], 1, "the record remains, so a no-change claim would be false");
});

for (const outcome of ["healthy", "set unapplied", "set acknowledgement lost", "record unapplied", "record acknowledgement lost", "extra slot", "boolean SET", "string HSET", "out-of-range HSET"] as const) {
  test(`creation needs both exact write receipts: ${outcome}`, async () => {
    redis.clear();
    let writes = 0;
    let commandsCounted = 0;
    let externalCalls = 0;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = async () => { externalCalls += 1; throw new Error("External calls are forbidden in this synthetic proof"); };
    redis.pipeline = async (commands) => {
      commandsCounted += commands.length;
      assert.ok(commandsCounted <= 2000, "command ceiling is counted before executing");
      if (commands.length !== 3 || commands[0]?.[0] !== "SET" || commands[1]?.[0] !== "HSET" || commands[2]?.[0] !== "HLEN") return original(commands);
      writes += 1;
      if (outcome === "set unapplied") {
        const rest = await original(commands.slice(1));
        return [null, rest[0], rest[1]];
      }
      if (outcome === "record unapplied") {
        const rest = await original([commands[0], commands[2]]);
        return [rest[0], null, rest[1]];
      }
      const reply = await original(commands);
      if (outcome === "set acknowledgement lost") return [null, reply[1], reply[2]];
      if (outcome === "record acknowledgement lost") return [reply[0], null, reply[2]];
      if (outcome === "extra slot") return [...reply, 0];
      if (outcome === "boolean SET") return [true, reply[1], reply[2]];
      if (outcome === "string HSET") return [reply[0], "1", reply[2]];
      if (outcome === "out-of-range HSET") return [reply[0], 2, reply[2]];
      return reply;
    };
    let made: Awaited<ReturnType<typeof makeKey>>;
    try { made = await makeKey(sid, "Synthetic receipt evidence"); }
    finally { redis.pipeline = original; globalThis.fetch = fetchBefore; }
    assert.equal(externalCalls, 0);
    assert.equal(writes, 1, "an unconfirmed write is never replayed");
    if (outcome === "healthy") {
      assert.equal(made.ok, true);
      if (!made.ok) throw new Error("Healthy creation was refused");
      assert.equal((await resolveKey(made.key))?.sid, sid);
    } else {
      if (outcome === "set unapplied" || outcome === "record unapplied") {
        assert.equal(made.ok && (await resolveKey(made.key)) !== null, false, "the unconfirmed write really left no usable key");
      }
      assert.deepEqual(made, { ok: false, reason: "make_unconfirmed" }, "a key is not announced as made without both write receipts");
    }
  });
}
