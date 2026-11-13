/**
 * Issue #4263 (hidden Codex G #3949): "Log out of all devices" (endAllSessions) reads the account's session set, then deletes
 * the whole set. A session opened by a login between the read and the delete is added to the set and then
 * deleted with it: the session lives on, but no later "Log out of all devices" can reach it.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emailForSession, endAllSessions, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];

test("a session opened while 'log out of all devices' runs stays reachable by the next one", async () => {
  const email = "race-3949@example.com";
  await openSession(email);
  const original = redis.pipeline.bind(redis);
  let late = "";
  let injected = false;
  redis.pipeline = async (commands: Command[]) => {
    const replies = await original(commands);
    // Right after endAllSessions read the set (SMEMBERS), a login on another device opens a session.
    if (!injected && commands.length === 1 && commands[0][0] === "SMEMBERS") {
      injected = true;
      redis.pipeline = original;
      late = await openSession(email);
      redis.pipeline = async (c: Command[]) => original(c);
    }
    return replies;
  };
  try {
    assert.equal(await endAllSessions(email), 1);
  } finally {
    redis.pipeline = original;
  }
  assert.ok(late, "the concurrent login opened a session");
  assert.equal(await emailForSession(late), email, "the late session is live (it began after the logout)");
  // A second "Log out of all devices" must close it.
  await endAllSessions(email);
  assert.equal(await emailForSession(late), null, "the late session is closed by the next 'log out of all devices'");
});
