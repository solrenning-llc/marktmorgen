/**
 * The host calendar's sync lock (lib/host-calendar.ts, hostSync; found by Claude 4 session 01S9eVA3nHQ while checking
 * Codex X5's X5-20261120-1342). The lock was SET NX with the value "1" and let go with a plain DEL. A reading that
 * outlives the lock's twenty seconds then deleted the lock a later reading had taken, and a third reading of the same
 * host could start beside the second. Each reading now takes the lock under a value of its own and lets go of it only
 * while it still holds that value (claimMark and releaseMark, lib/claim-mark.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostSync, hostCalendarKeys } from "@/lib/host-calendar";
import { hostId } from "@/lib/host-claims";
import { seal } from "@/lib/secret-box";
import { store as redis } from "./redis-stub";
import { state } from "./host-calendar-lock-owner-world";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const email = "lock-owner@example.com";
const host = hostId(email);
const [cfg, , , lock] = hostCalendarKeys(host);
const store = { statsId: "lock-owner-stats", sid: "", email: "" };

async function seed(): Promise<void> {
  redis.clear();
  state.during = async () => {};
  state.reads = 0;
  await redis.pipeline([["SET", cfg, JSON.stringify({ email, source: "ics", read: [], write: "", ics: seal("https://calendar.example.test/private.ics", `hostcal|${host}|ics`), icsAddedAt: "2026-11-20" })]]);
}

test("a reading that outlived its lock never deletes the lock a later reading took", async () => {
  await seed();
  state.during = async () => {
    // The first reading's twenty seconds ran out, and a later reading took the lock under its own value.
    await redis.pipeline([["DEL", lock], ["SET", lock, "1800000000000.000000002", "EX", 20]]);
  };
  const first = await hostSync(store, email, "UTC", { now: state.now, force: true });
  assert.equal(first.state, "ok", "control: the first reading itself was read");
  const [held] = await redis.pipeline([["GET", lock]]);
  assert.equal(held, "1800000000000.000000002", "the later reading's lock is still there");
  state.during = async () => {};
  const third = await hostSync(store, email, "UTC", { now: state.now, force: true });
  assert.equal(state.reads, 1, "so a third reading does not start beside the second");
  assert.notEqual(third.busy.length, 0, "control: it answers from the kept reading");
});

test("while a reading holds the lock, a second one does not read the calendar", async () => {
  await seed();
  let second: Awaited<ReturnType<typeof hostSync>> | null = null;
  state.during = async () => {
    state.during = async () => {};
    second = await hostSync(store, email, "UTC", { now: state.now, force: true });
  };
  await hostSync(store, email, "UTC", { now: state.now, force: true });
  assert.equal(state.reads, 1, "only the lock's holder read the calendar");
  assert.notEqual(second, null);
});

test("a reading lets go of its own lock when it ends", async () => {
  await seed();
  await hostSync(store, email, "UTC", { now: state.now, force: true });
  const [held] = await redis.pipeline([["GET", lock]]);
  assert.equal(held, null);
});

test("the lock is taken under a value of its own, not a shared one", async () => {
  await seed();
  let seen: unknown = undefined;
  state.during = async () => {
    [seen] = await redis.pipeline([["GET", lock]]);
  };
  await hostSync(store, email, "UTC", { now: state.now, force: true });
  assert.equal(typeof seen, "string");
  assert.notEqual(seen, "1", "a value only this reading writes");
});
