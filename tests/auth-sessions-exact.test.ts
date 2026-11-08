/**
 * Logging out, and opening the session a login opens, read exactly (CX-123 rule 24; Claude 4's auth sweep).
 *
 *   - "Log out of all devices" whose own session could not be read said "logged out of all devices" and closed
 *     nothing: the laptop that walked off stayed logged in for thirty days.
 *   - Logging out whose delete failed said "You're logged out" while the session lived on at the server.
 *   - A session whose place in the account's set was not confirmed was opened all the same, out of reach of
 *     "Log out of all devices".
 *   - The deletes that log sessions out were never read: an answer missing was counted as closed.
 *   - A locked session (lib/two-step.ts openLockedSession, the "no app, no codes, no passkey" way in) whose lock
 *     was not confirmed was handed out all the same: a full session, unlocked (review of #2948 at 929dec4d).
 *
 * Each unknown is said as such, never as done; the healthy paths and confirmed absence answer as before.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, SessionsUnknownError, dropSecondStep, emailForSession, endAllSessions, openSession } from "@/lib/auth";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as signOutAll } from "@/app/api/auth/signout-all/route";
import { POST as signOut } from "@/app/api/auth/signout/route";
import { lockedUntil, openLockedSession } from "@/lib/two-step";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];
/** What a tampered command answers instead of the store: a reply of its own, or an error from Redis. */
type Answer = { reply: unknown } | "throw" | null;

/** Runs `work` with some commands answered by `hook` (one at a time, in order), the rest by the store as usual. */
async function tampered<T>(hook: (command: Command, all: Command[]) => Answer, work: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: Command[]) => {
    const out: unknown[] = [];
    for (const command of commands) {
      const answer = hook(command, commands);
      if (answer === "throw") throw new Error("Redis error: a stand-in failure");
      out.push(answer ? answer.reply : (await original([command]))[0]);
    }
    return out;
  };
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** Runs `work` with every pipeline that holds a command `matching` answered as `answer(commands)` instead. */
async function wholePipeline<T>(matching: (command: Command) => boolean, answer: (commands: Command[]) => unknown[], work: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: Command[]) => (commands.some(matching) ? answer(commands) : original(commands));
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const SITE = "https://marktmorgen.com";
const post = (path: string, session?: string) =>
  new NextRequest(`${SITE}${path}`, { method: "POST", headers: { host: "marktmorgen.com", origin: SITE, ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}) } });
const isSessionRead = (c: Command) => c[0] === "GET" && String(c[1]).startsWith("nl:auth:session:");
const cookieCleared = (response: Response) => response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && c.includes("Max-Age=0"));

// ---- "Log out of all devices" ----------------------------------------------------------------------------------

for (const [label, reply] of [["no result", undefined], ["a number", 42], ["a list", ["owner@example.com"]]] as const) {
  test(`log out of all devices, its own session read as ${label}: said as not done, never "logged out of all devices"`, async () => {
    redis.clear();
    const here = await openSession("owner@example.com");
    const laptop = await openSession("owner@example.com");
    const response = await tampered((c) => (isSessionRead(c) ? { reply } : null), () => signOutAll(post("/api/auth/signout-all", here)));
    assert.equal(response.headers.get("location"), `${SITE}/signin?status=out-everywhere-unknown`);
    assert.equal(cookieCleared(response), true);
    // Nothing was closed, and nothing claims it was.
    assert.equal(await emailForSession(laptop), "owner@example.com");
  });
}

test("log out of all devices, read in its shape: every session is closed and said so", async () => {
  redis.clear();
  const here = await openSession("owner@example.com");
  const laptop = await openSession("owner@example.com");
  const response = await signOutAll(post("/api/auth/signout-all", here));
  assert.equal(response.headers.get("location"), `${SITE}/signin?status=out-everywhere`);
  assert.deepEqual([await emailForSession(here), await emailForSession(laptop)], [null, null]);
});

test("log out of all devices with no session at all (confirmed absent): nothing to close, said as done", async () => {
  redis.clear();
  const none = await signOutAll(post("/api/auth/signout-all"));
  const gone = await signOutAll(post("/api/auth/signout-all", "a".repeat(64)));
  assert.deepEqual([none.headers.get("location"), gone.headers.get("location")], [`${SITE}/signin?status=out-everywhere`, `${SITE}/signin?status=out-everywhere`]);
});

// ---- Logging out of this browser --------------------------------------------------------------------------------

test("log out, its delete failing: this browser is logged out, but the page never says the session is gone", async () => {
  redis.clear();
  const here = await openSession("owner@example.com");
  const response = await tampered((c) => (c[0] === "DEL" ? "throw" : null), () => signOut(post("/api/auth/signout", here)));
  assert.equal(response.headers.get("location"), `${SITE}/signin?status=out-unknown&to=login`);
  assert.equal(cookieCleared(response), true);
  assert.equal(await emailForSession(here), "owner@example.com");
});

for (const [label, reply] of [["no result", undefined], ["text", "OK"], ["a negative count", -1]] as const) {
  test(`log out, its delete answered as ${label}: not said as logged out at the server`, async () => {
    redis.clear();
    const here = await openSession("owner@example.com");
    const response = await tampered((c) => (c[0] === "DEL" && String(c[1]).startsWith("nl:auth:session:") ? { reply } : null), () => signOut(post("/api/auth/signout", here)));
    assert.equal(response.headers.get("location"), `${SITE}/signin?status=out-unknown&to=login`);
  });
}

test("log out, read in its shape, or with no session to close: said as logged out", async () => {
  redis.clear();
  const here = await openSession("owner@example.com");
  const done = await signOut(post("/api/auth/signout", here));
  const none = await signOut(post("/api/auth/signout"));
  assert.deepEqual([done.headers.get("location"), none.headers.get("location")], [`${SITE}/signin?status=out`, `${SITE}/signin?status=out`]);
  assert.equal(await emailForSession(here), null);
  assert.equal(cookieCleared(done), true);
});

// ---- Opening a session -------------------------------------------------------------------------------------------

const opening = (c: Command) => c[0] === "SADD" && String(c[1]).startsWith("nl:auth:sessions:");

for (const [label, answer] of [
  ["place in the account's set answered with nothing (not applied)", (c: Command): Answer => (opening(c) ? { reply: undefined } : null)],
  ["own write answered as something else", (c: Command): Answer => (c[0] === "SET" && String(c[1]).startsWith("nl:auth:session:") ? { reply: "QUEUED" } : null)],
] as const) {
  test(`a session whose ${label} is not opened: the login fails, and nothing is left that logs in`, async () => {
    redis.clear();
    let written = "";
    const failed = await tampered(
      (c) => {
        if (c[0] === "SET" && String(c[1]).startsWith("nl:auth:session:")) written = String(c[1]);
        return answer(c);
      },
      () => openSession("owner@example.com").then(() => "opened", (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error))),
    );
    assert.equal(failed, "unknown");
    const [left] = await redis.pipeline([["GET", written]]);
    assert.equal(left, null);
  });
}

test("a session whose pipeline answered short is not opened", async () => {
  redis.clear();
  await assert.rejects(() => wholePipeline(opening, () => ["OK"], () => openSession("owner@example.com")), UnknownReplyError);
});

test("a session answered in its shape opens as before, with its second step, and every way out reaches it", async () => {
  redis.clear();
  const id = await openSession("owner@example.com", "passkey", "pk-1");
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(await emailForSession(id), "owner@example.com");
  assert.equal(await endAllSessions("owner@example.com"), 1);
  assert.equal(await emailForSession(id), null);
});

// ---- The deletes that log sessions out --------------------------------------------------------------------------

const deleting = (c: Command) => c[0] === "DEL" && String(c[1]).startsWith("nl:auth:session:");

for (const [label, reply] of [["short", () => []], ["as text", (commands: Command[]) => commands.map(() => "OK")]] as const) {
  test(`log out everywhere whose deletes answered ${label}: unknown, never a count of sessions closed`, async () => {
    redis.clear();
    await openSession("owner@example.com");
    await openSession("owner@example.com");
    assert.equal(await wholePipeline(deleting, reply, () => endAllSessions("owner@example.com")), null);
  });

  test(`a second step taken away, the deletes answered ${label}: fails, never said as logged out`, async () => {
    redis.clear();
    const byKey = await openSession("owner@example.com", "passkey", "pk-gone");
    await openSession("owner@example.com", "passkey", "pk-gone");
    const gone = (mark: string) => mark === "passkey:pk-gone";
    await assert.rejects(() => wholePipeline((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:auth:second:"), reply, () => dropSecondStep("owner@example.com", gone, byKey)), SessionsUnknownError);
  });
}

test("the deletes read in their shape: the count is the sessions closed, as before", async () => {
  redis.clear();
  const byKey = await openSession("owner@example.com", "passkey", "pk-gone");
  const other = await openSession("owner@example.com", "passkey", "pk-gone");
  const plain = await openSession("owner@example.com");
  assert.equal(await dropSecondStep("owner@example.com", (mark) => mark === "passkey:pk-gone", byKey), 1);
  assert.deepEqual([await emailForSession(byKey), await emailForSession(other), await emailForSession(plain)], ["owner@example.com", null, "owner@example.com"]);
  assert.equal(await endAllSessions("owner@example.com"), 2);
  assert.equal(await endAllSessions("nobody@example.com"), 0);
});

// ---- A locked session: its lock read exactly ---------------------------------------------------------------------

const LOCKED = "lost@example.com";
const isLockWrite = (c: Command) => String(c[1]).startsWith("nl:2fa:locked:") || String(c[1]).startsWith("nl:2fa:lockedset:");

for (const [label, hook] of [
  ["its lock's SET not applied (no answer)", (c: Command): Answer => (c[0] === "SET" && String(c[1]).startsWith("nl:2fa:locked:") ? { reply: undefined } : null)],
  ["its lock's SET answered a number", (c: Command): Answer => (c[0] === "SET" && String(c[1]).startsWith("nl:2fa:locked:") ? { reply: 1 } : null)],
  ["the account's locked set answered as text", (c: Command): Answer => (c[0] === "SADD" && String(c[1]).startsWith("nl:2fa:lockedset:") ? { reply: "OK" } : null)],
  ["the locked set's expiry answered nothing", (c: Command): Answer => (c[0] === "EXPIRE" && String(c[1]).startsWith("nl:2fa:lockedset:") ? { reply: null } : null)],
  ["Redis failing on the lock", (c: Command): Answer => (isLockWrite(c) ? "throw" : null)],
] as const) {
  test(`a locked session, ${label}: refused and taken back, never handed out unlocked`, async () => {
    redis.clear();
    await assert.rejects(() => tampered(hook, () => openLockedSession(LOCKED, Date.now() + 7 * 86_400_000)));
    // Nothing of it is left open: the account holds no session.
    assert.equal(await endAllSessions(LOCKED), 0);
  });
}

test("a locked session whose lock pipeline answered short: refused and taken back", async () => {
  redis.clear();
  await assert.rejects(() => wholePipeline((c) => c[0] === "SET" && String(c[1]).startsWith("nl:2fa:locked:"), () => [], () => openLockedSession(LOCKED, Date.now() + 7 * 86_400_000)), UnknownReplyError);
  assert.equal(await endAllSessions(LOCKED), 0);
});

test("a locked session answered in its shape opens as before, locked until its day", async () => {
  redis.clear();
  const until = Date.now() + 7 * 86_400_000;
  const id = await openLockedSession(LOCKED, until);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(await emailForSession(id), LOCKED);
  assert.equal(await lockedUntil(id), until);
  assert.equal(await endAllSessions(LOCKED), 1);
});
