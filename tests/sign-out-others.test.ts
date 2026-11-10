/**
 * "Log out of other devices" (757 [STN4], unit 1; Claude 4, 9 November 2026).
 *
 * Until now the studio had only "Log out of all devices": the creator who found a laptop still logged in had to log
 * this browser out too, then find the emailed link again to come back. This closes every OTHER session of the
 * account and keeps this one, after a page that asks first (AX274 3.3.6), with no time limit.
 *
 * It answers exactly as "Log out of all devices" does (CX-123 rule 24; tests/auth-sessions-exact.test.ts): an
 * unknown read or delete is never said as done, a locked session (lib/two-step.ts) may not use it, and another
 * account's sessions are never touched. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession, endOtherSessions, openSession, sessionMark } from "@/lib/auth";
import { POST as signOutOthers } from "@/app/api/auth/signout-others/route";
import { openLockedSession } from "@/lib/two-step";
import { advance, store as redis } from "./redis-stub";

type Command = (string | number)[];
type Answer = { reply: unknown } | "throw" | null;

/** Runs `work` with some commands answered by `hook` (one at a time, in order), the rest by the store as usual. */
async function tampered<T>(hook: (command: Command) => Answer, work: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: Command[]) => {
    const out: unknown[] = [];
    for (const command of commands) {
      const answer = hook(command);
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

const SITE = "https://marktmorgen.com";
const OWNER = "owner@example.com";
const post = (session?: string, origin = SITE) =>
  new NextRequest(`${SITE}/api/auth/signout-others`, {
    method: "POST",
    headers: { host: "marktmorgen.com", origin, ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}) },
  });
const isSessionRead = (c: Command) => c[0] === "GET" && String(c[1]).startsWith("nl:auth:session:");
const isSetRead = (c: Command) => c[0] === "SMEMBERS" && String(c[1]).startsWith("nl:auth:sessions:");
const DONE = `${SITE}/studio/devices?status=out-others`;
const UNKNOWN = `${SITE}/studio/devices?status=out-others-unknown`;
const REAUTH = `${SITE}/studio/devices?status=out-others-reauth`;
const cookieCleared = (response: Response) => response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`));

// ---- The function ------------------------------------------------------------------------------------------------

test("every other session of the account is closed, this one stays logged in, and the count is said", async () => {
  redis.clear();
  const here = await openSession(OWNER);
  const laptop = await openSession(OWNER);
  const phone = await openSession(OWNER, "app");
  const neighbour = await openSession("someone-else@example.com");
  assert.equal(await endOtherSessions(OWNER, here), 2);
  assert.deepEqual(
    [await emailForSession(here), await emailForSession(laptop), await emailForSession(phone), await emailForSession(neighbour)],
    [OWNER, null, null, "someone-else@example.com"],
  );
  // The phone's second-step mark goes with it; this session keeps its own mark and its place in the account's set.
  assert.equal(await sessionMark(phone, OWNER), null);
  assert.equal(await endOtherSessions(OWNER, here), 0, "only this browser is left, so nothing more is closed");
});

test("this session keeps the second step it was opened with", async () => {
  redis.clear();
  const here = await openSession(OWNER, "app");
  await openSession(OWNER);
  assert.equal(await endOtherSessions(OWNER, here), 1);
  assert.equal(await sessionMark(here, OWNER), "app");
});

test("a session id in the wrong shape keeps nothing: it is refused, never read as 'keep none' and closing every session", async () => {
  redis.clear();
  const here = await openSession(OWNER);
  assert.equal(await endOtherSessions(OWNER, "not-a-session"), null);
  assert.equal(await endOtherSessions(OWNER, undefined), null);
  assert.equal(await emailForSession(here), OWNER);
});

for (const [label, reply] of [["no result", undefined], ["a number", 3], ["a list with a number", ["nl:auth:session:x", 4]]] as const) {
  test(`the account's sessions read as ${label}: unknown (null), and nothing is closed`, async () => {
    redis.clear();
    const here = await openSession(OWNER);
    const laptop = await openSession(OWNER);
    assert.equal(await tampered((c) => (isSetRead(c) ? { reply } : null), () => endOtherSessions(OWNER, here)), null);
    assert.equal(await emailForSession(laptop), OWNER);
  });
}

for (const [label, reply] of [["no result", undefined], ["text", "OK"], ["a count of 2", 2]] as const) {
  test(`a delete answered as ${label}: unknown (null), never a count of sessions closed`, async () => {
    redis.clear();
    const here = await openSession(OWNER);
    await openSession(OWNER);
    assert.equal(await tampered((c) => (c[0] === "DEL" ? { reply } : null), () => endOtherSessions(OWNER, here)), null);
  });
}

test("Redis failing: unknown (null), never thrown at the page and never said as done", async () => {
  redis.clear();
  const here = await openSession(OWNER);
  assert.equal(await tampered((c) => (isSetRead(c) ? "throw" : null), () => endOtherSessions(OWNER, here)), null);
});

// ---- The route ---------------------------------------------------------------------------------------------------

test("the route closes the others, keeps this browser logged in and says so", async () => {
  redis.clear();
  const here = await openSession(OWNER);
  const laptop = await openSession(OWNER);
  const response = await signOutOthers(post(here));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), DONE);
  assert.equal(cookieCleared(response), false, "this browser is not logged out");
  assert.deepEqual([await emailForSession(here), await emailForSession(laptop)], [OWNER, null]);
});

for (const [label, reply] of [["no result", undefined], ["a number", 42], ["a list", [OWNER]]] as const) {
  test(`the route, its own session read as ${label}: said as not done, and nothing is closed`, async () => {
    redis.clear();
    const here = await openSession(OWNER);
    const laptop = await openSession(OWNER);
    const response = await tampered((c) => (isSessionRead(c) ? { reply } : null), () => signOutOthers(post(here)));
    assert.equal(response.headers.get("location"), UNKNOWN);
    assert.equal(await emailForSession(laptop), OWNER);
  });
}

test("the route, the account's sessions unreadable: said as not done", async () => {
  redis.clear();
  const here = await openSession(OWNER);
  const laptop = await openSession(OWNER);
  const response = await tampered((c) => (isSetRead(c) ? { reply: 7 } : null), () => signOutOthers(post(here)));
  assert.equal(response.headers.get("location"), UNKNOWN);
  assert.equal(await emailForSession(laptop), OWNER);
});

test("the route with no session (confirmed absent) sends to the login page and closes nothing", async () => {
  redis.clear();
  const laptop = await openSession(OWNER);
  for (const session of [undefined, "a".repeat(64)]) {
    const response = await signOutOthers(post(session));
    assert.equal(response.headers.get("location"), `${SITE}/signin`);
  }
  assert.equal(await emailForSession(laptop), OWNER);
});

test("a session let in without its second step (locked) may not log the others out", async () => {
  redis.clear();
  const laptop = await openSession(OWNER, "app");
  const locked = await openLockedSession(OWNER, Date.now() + 7 * 86_400_000);
  const response = await signOutOthers(post(locked));
  assert.equal(response.headers.get("location"), `${SITE}/studio?two-step=locked`);
  assert.equal(await emailForSession(laptop), OWNER);
});

test("a session that is not fresh (a cookie that walked off) may not log the owner out and stay in (Claude 3 on #3459)", async () => {
  // Unlike "Log out of all devices", this keeps the presser logged in, so it needs a login from the last
  // FRESH_LOGIN_SECONDS, as adding a passkey or a recovery address does; otherwise a stolen cookie could log the
  // owner out everywhere, again each time they came back.
  redis.clear();
  const owner = await openSession(OWNER);
  const stolen = await openSession(OWNER);
  advance(16 * 60 * 1000);
  const response = await signOutOthers(post(stolen));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), REAUTH);
  assert.deepEqual([await emailForSession(owner), await emailForSession(stolen)], [OWNER, OWNER], "nothing is closed");
  // A fresh login (the owner's own, just now) still may.
  const fresh = await openSession(OWNER);
  const done = await signOutOthers(post(fresh));
  assert.equal(done.headers.get("location"), DONE);
  assert.deepEqual([await emailForSession(owner), await emailForSession(stolen), await emailForSession(fresh)], [null, null, OWNER]);
});

test("a freshness read that is not an exact answer is not fresh: nothing is closed", async () => {
  redis.clear();
  const here = await openSession(OWNER);
  const laptop = await openSession(OWNER);
  const isFreshRead = (c: Command) => c[0] === "EXISTS" && String(c[1]).startsWith("nl:auth:fresh:");
  const response = await tampered((c) => (isFreshRead(c) ? { reply: "1" } : null), () => signOutOthers(post(here)));
  assert.equal(response.headers.get("location"), REAUTH);
  assert.equal(await emailForSession(laptop), OWNER);
});

test("a request from another site is refused before anything is read", async () => {
  redis.clear();
  const here = await openSession(OWNER);
  const laptop = await openSession(OWNER);
  const response = await signOutOthers(post(here, "https://evil.example"));
  assert.equal(response.status, 403);
  assert.equal(await emailForSession(laptop), OWNER);
});

// ---- The page that asks first ------------------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("the studio links to the page, and the page asks before it closes anything (AX274 3.3.6), with no time limit", () => {
  const studio = read("app/studio/page.tsx");
  assert.match(studio, /href=\{studioPath\(store, "", "devices"\)\}[\s\S]{0,400}Log out of other devices/);
  const page = read("app/studio/devices/page.tsx");
  // A plain form that posts only when the creator presses the button: nothing is closed by opening the page.
  assert.match(page, /<form action="\/api\/auth\/signout-others" method="post"/);
  assert.match(page, /Yes, log out the other devices/);
  assert.match(page, /Keep them logged in/);
  // The result is announced in a live region, and an unknown result is never said as done.
  assert.match(page, /role="status"/);
  assert.match(page, /"out-others-unknown"/);
  assert.doesNotMatch(page, /setTimeout|setInterval|http-equiv="refresh"/i);
  // One h1, and the page names the region it lives in.
  assert.equal(page.match(/<h1\b/g)?.length, 1);
  assert.match(page, /<main id="content"/);
});

test("the page asks a session that is not fresh to log in again, in plain words, with a way to do it", () => {
  const page = read("app/studio/devices/page.tsx");
  assert.match(page, /"out-others-reauth"/);
  assert.match(page, /For your safety, log in again to log out your other devices\./);
  assert.match(page, /href="\/signin\?to=login"/);
});

test("the page promises no more than the code does (Claude 3 on #3459, rule 27)", () => {
  const page = read("app/studio/devices/page.tsx");
  // A login that finishes during the sign-out may stay open, so the page never says "every other device is logged out".
  assert.doesNotMatch(page, /Every other device is logged out/);
  assert.match(page, /Every other device that was logged in is now logged out\./);
  // API keys are not sessions: a script holding one keeps working until the key is revoked.
  assert.match(page, /API keys are not affected/);
  // A passkey or Google login also gets back in, with no email (Claude 2 on #3459, VR item 2).
  assert.doesNotMatch(page, /needs a new login link sent to your email/);
  assert.match(page, /someone needs to log in to your account again\./);
});
