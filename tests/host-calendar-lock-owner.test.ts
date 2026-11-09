import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hostSync } from "@/lib/host-calendar";
import { hostId } from "@/lib/host-claims";
import { store as redis } from "./redis-stub";

// A host's calendar reading is done by one pass at a time (nl:hostcal:lock:). A pass slow enough for its lock to run
// out must never delete the lock another pass took since: that would let a third pass read the provider beside it.

const pipeline = redis.pipeline.bind(redis);
const now = 1_800_000_000_000;
const store = { statsId: "calendar-lock-owner" };
const email = "host@example.com";
const host = hostId(email);
const lock = `nl:hostcal:lock:${host}`;
// "sealed" is not a value this deployment can open, so the read fails at once: the pass goes through its error path
// and its finally, which is all this test needs, without any request leaving the machine.
const config = JSON.stringify({ email, source: "ics", read: [], write: "", ics: "sealed", icsAddedAt: "2026-11-05" });
let commands: (string | number)[][];
let onErrorWrite: (() => void) | null;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  redis.clear();
  commands = [];
  onErrorWrite = null;
  globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
  await pipeline([["SET", `nl:hostcal:cfg:${host}`, config]]);
  redis.pipeline = (async (sent: (string | number)[][]) => {
    commands.push(...sent);
    if (sent[0]?.[0] === "SET" && String(sent[0]?.[1]).startsWith("nl:hostcal:err:") && onErrorWrite) onErrorWrite();
    return pipeline(sent);
  }) as typeof redis.pipeline;
});
afterEach(() => { redis.pipeline = pipeline; globalThis.fetch = originalFetch; });

test("a slow pass whose lock ran out never deletes the lock another pass took since", async () => {
  let ours: unknown = null;
  onErrorWrite = () => {
    // While this pass was reading, its lock ran out and another pass took it with its own value.
    ours = redis.run(["GET", lock]);
    redis.run(["SET", lock, "another-pass", "EX", 20]);
  };
  const reading = await hostSync(store, email, "UTC", { now, force: true });
  assert.equal(reading.state, "failed", "the sealed address cannot be opened here");
  assert.equal(typeof ours, "string", "the pass held the lock while it read");
  assert.equal(redis.run(["GET", lock]), "another-pass", "the other pass's lock is still there");
});

test("each pass writes a lock value of its own, never a shared constant", async () => {
  const seen: unknown[] = [];
  onErrorWrite = () => { seen.push(redis.run(["GET", lock])); };
  await hostSync(store, email, "UTC", { now, force: true });
  await hostSync(store, email, "UTC", { now, force: true });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], "1");
  assert.notEqual(seen[0], seen[1], "two passes never hold the same value");
});

test("a pass lets its own lock go when it is done", async () => {
  await hostSync(store, email, "UTC", { now, force: true });
  assert.equal(redis.run(["GET", lock]), null, "the lock is free for the next pass");
  assert.ok(!commands.some((c) => c[0] === "DEL" && c.includes(lock)), "never a bare DEL of the lock");
});

test("a lock another pass holds stops this pass before any read or release", async () => {
  await pipeline([["SET", lock, "another-pass", "EX", 20]]);
  const reading = await hostSync(store, email, "UTC", { now, force: true });
  assert.equal(reading.state, "failed");
  assert.equal(redis.run(["GET", lock]), "another-pass");
  assert.ok(!commands.some((c) => c[0] === "EVAL" || c[0] === "DEL"), "nothing let go that is not ours");
});
