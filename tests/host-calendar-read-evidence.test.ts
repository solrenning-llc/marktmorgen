import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hostSync, prefetchHosts } from "@/lib/host-calendar";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
const now = 1_800_000_000_000;
const store = { statsId: "calendar-evidence" };
const email = "host@example.com";
const config = JSON.stringify({ email, source: "ics", read: [], write: "", ics: "sealed", icsAddedAt: "2026-11-05" });
const good = JSON.stringify({ at: now, busy: [[now + 60_000, now + 120_000]], source: "ics" });
let reply: unknown;
let lockReply: unknown;
let commands: (string | number)[][];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  redis.clear();
  commands = [];
  lockReply = ["OK"];
  globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
  redis.pipeline = (async (sent: (string | number)[][]) => {
    commands.push(...sent);
    if (sent[0]?.[0] === "MGET") return reply as never;
    if (sent[0]?.[0] === "SET" && String(sent[0]?.[1]).startsWith("nl:hostcal:lock:")) return lockReply as never;
    return pipeline(sent);
  }) as typeof redis.pipeline;
});
afterEach(() => { redis.pipeline = pipeline; globalThis.fetch = originalFetch; });

for (const [label, value] of Object.entries({
  missing: [], null: [null], short: [[null]], extra: [[null, null, null, null]],
  outerExtra: [[null, null, null], null], wrongType: [[0, null, null]],
  sparse: [Array(3)], malformedConfig: [["{", null, null]],
  unknownSource: [[JSON.stringify({ source: "icss" }), null, null]],
  malformedGood: [[config, JSON.stringify({ at: now, busy: [[now + 10, now]], source: "ics" }), null]],
  unreadableGood: [[config, "{", null]],
  futureGood: [[config, JSON.stringify({ at: now + 1, busy: [], source: "ics" }), null]],
  malformedError: [[config, good, JSON.stringify({ at: "later", message: "wait" })]],
})) {
  test(`unknown host calendar evidence blocks the host: ${label}`, async () => {
    reply = value;
    const reading = await hostSync(store, email, "UTC", { now });
    assert.equal(reading.blocked, true, "unknown must never become an available host");
    assert.equal(reading.state, "failed");
    assert.deepEqual(reading.busy, []);
    assert.equal(commands.length, 1, "one existing bounded read; no retry or write");
  });
}

test("confirmed absent settings still mean no external calendar", async () => {
  reply = [[null, null, null]];
  const reading = await hostSync(store, email, "UTC", { now });
  assert.equal(reading.state, "none");
  assert.equal(reading.blocked, false);
});

test("a complete fresh reading preserves every busy interval", async () => {
  reply = [[config, good, null]];
  const reading = await hostSync(store, email, "UTC", { now });
  assert.equal(reading.state, "ok");
  assert.equal(reading.blocked, false);
  assert.deepEqual(reading.busy, [{ start: now + 60_000, end: now + 120_000 }]);
});

for (const [label, value] of Object.entries({
  outerExtra: [[null, null, null, null], null],
  sparse: [Array(4)], badValue: [[null, null, null, 1]],
})) {
  test(`host prefetch refuses unknown evidence: ${label}`, async () => {
    reply = value;
    await assert.rejects(prefetchHosts(store, [email]), /could not be read/);
    assert.equal(commands.length, 1);
  });
}

test("complete prefetch keeps explicit nulls and the stored strings", async () => {
  reply = [[config, good, null, null]];
  const hosts = await prefetchHosts(store, [email]);
  assert.deepEqual(hosts.get(email), { cfg: config, good, err: null, conn: null });
  const reading = await hostSync(store, email, "UTC", { now, known: hosts.get(email) });
  assert.equal(reading.state, "ok");
  assert.equal(commands.length, 1, "prefetch avoids another database read");
});

for (const [label, value] of Object.entries({
  missing: [], undefined: [undefined], wrongType: [1], wrongWord: ["ok"], extra: ["OK", null], sparse: Array(1),
})) {
  test(`unknown refresh lock never authorizes work or lock deletion: ${label}`, async () => {
    lockReply = value;
    const reading = await hostSync(store, email, "UTC", { now, force: true, known: { cfg: config, good, err: null, conn: null } });
    assert.equal(reading.state, "ok", "the already verified fresh cache may still be used");
    assert.equal(commands.length, 1, "only the lock request; no provider/cache write or deletion of somebody else's lock");
    assert.equal(commands[0][0], "SET");
  });
}
