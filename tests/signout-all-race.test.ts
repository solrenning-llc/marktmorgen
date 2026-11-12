/**
 * "Log out of all devices" and a login that lands while it runs (Codex G's
 * MEDIUM, issue #4263, hidden #3949). endAllSessions read the account's
 * session set, then deleted every session read and the whole set: a session
 * opened between the read and the delete was added to the set and deleted with
 * it, so it stayed live for its 30 days and no later "Log out of all devices"
 * could find it. Now only the sessions read are taken off the set (SREM), as
 * dropSecondStep does; one opened since stays in it, and the next one closes
 * it. Synthetic in-memory Redis only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emailForSession, endAllSessions, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];

test("a session opened while 'log out of all devices' runs stays reachable by the next one", async () => {
  redis.clear();
  const email = "race-4263@example.com";
  const first = await openSession(email);
  const original = redis.pipeline.bind(redis);
  let late = "";
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await original(commands);
    // Right after endAllSessions read the set (SMEMBERS), a login on another device opens a session.
    if (!late && commands.length === 1 && commands[0][0] === "SMEMBERS") {
      redis.pipeline = original;
      late = await openSession(email);
    }
    return replies;
  }) as typeof redis.pipeline;
  try {
    assert.equal(await endAllSessions(email), 1, "the session read is the one closed");
  } finally {
    redis.pipeline = original;
  }
  assert.equal(await emailForSession(first), null, "the session read is closed");
  assert.ok(late, "the concurrent login opened a session");
  assert.equal(await emailForSession(late), email, "the late session is live: it began after the logout read");
  assert.equal(await endAllSessions(email), 1, "the next 'log out of all devices' finds it");
  assert.equal(await emailForSession(late), null, "and closes it");
});

test("with nothing opened meanwhile, everything is closed and nothing of the set is left", async () => {
  redis.clear();
  const email = "plain-4263@example.com";
  const a = await openSession(email);
  const b = await openSession(email);
  assert.equal(await endAllSessions(email), 2);
  assert.deepEqual([await emailForSession(a), await emailForSession(b)], [null, null]);
  assert.equal(await endAllSessions(email), 0, "a second run finds none");
});

test("a set taken off answered in another shape: unknown, never a count of sessions closed", async () => {
  redis.clear();
  const email = "shape-4263@example.com";
  await openSession(email);
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await original(commands);
    return commands.map((c, i) => (c[0] === "SREM" ? "OK" : replies[i]));
  }) as typeof redis.pipeline;
  try {
    assert.equal(await endAllSessions(email), null);
  } finally {
    redis.pipeline = original;
  }
});
