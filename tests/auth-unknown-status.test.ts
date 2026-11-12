/**
 * Rule 24 for the three login routes that spend something before the session
 * opens (app/api/auth/lost/confirm, app/api/auth/rescue, app/api/auth/code):
 * once the link or the code has been spent, a read in an unknown shape, or a
 * session that could not be opened, is never "That link no longer works" and
 * never a bare error page. The person is sent to /signin?status=login-unknown,
 * gets no session cookie, keeps no session in Redis, and can finish logging in
 * with a fresh link or code.
 *
 *   - a link to the recovery address, spent, then the two-step record or the
 *     session write answering in another shape;
 *   - the recovery-address link that turns two-step login off: its spend not
 *     known, or two-step login turned off and the session write not confirmed;
 *   - a right recovery code, spent, and the session write not confirmed.
 *
 * Controls: each route's healthy login, and a link that is really spent still
 * says it expired. Synthetic records only; no email leaves.
 */
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { emailForSession } from "@/lib/auth";
import { holdSignIn, twoStepOn } from "@/lib/two-step";
import { POST as lostConfirm } from "@/app/api/auth/lost/confirm/route";
import { POST as rescueRoute } from "@/app/api/auth/rescue/route";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { POST as callback } from "@/app/api/auth/callback/route";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const recordKey = (email: string) => `nl:2fa:${sha(`nimbus-2fa:${email}`).slice(0, 40)}`;
const codeHash = (code: string) => sha(`nimbus-2fa-code:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`);
const lostLinkKey = (token: string) => `nl:auth:rec:link:${sha(`nimbus-rec-link:${token}`).slice(0, 40)}`;
const rescueKey = (token: string) => `nl:2fa:rescue:${sha(`nimbus-2fa-rescue:${token}`).slice(0, 40)}`;
const signInLinkKey = (token: string) => `nl:auth:link:${sha(`nimbus-auth-link:${token}`).slice(0, 40)}`;
const record = (codes: string[]) => JSON.stringify({ s: "synthetic-sealed-secret", since: 1, codes: codes.map(codeHash), last: -1, reset: 0, backup: "" });
const freshToken = () => sha(String(Math.random()));

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
/** Every command `match` picks answers `reply` instead of what the stand-in answered. */
async function withReply<T>(match: (cmd: Cmd) => boolean, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Cmd[]) => {
    const out = await original(commands);
    return commands.map((cmd, i) => (match(cmd) ? reply : out[i]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}
const isGet = (key: string) => (cmd: Cmd) => cmd[0] === "GET" && cmd[1] === key;
/** openSession's write of the session itself (lib/auth.ts): anything but "OK" and the session is taken back. */
const sessionWrite = (cmd: Cmd) => cmd[0] === "SET" && String(cmd[1]).startsWith("nl:auth:session:");

const post = (url: string, fields: Record<string, string>, cookie = "") =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields),
  });
const cookieOf = (response: Response, name: string) =>
  new RegExp(`(?:^|[,\\s])${name}=([^;]*)`).exec(response.headers.get("set-cookie") ?? "")?.[1];
const UNKNOWN_LOGIN = "https://marktmorgen.com/signin?status=login-unknown";
const EXPIRED = "https://marktmorgen.com/signin?status=expired";

async function noSessionsLeft(): Promise<void> {
  const [scan] = await original([["SCAN", "0", "MATCH", "nl:auth:session:*"]]);
  assert.deepEqual((scan as [string, string[]])[1], [], "no session was left in Redis");
}

async function lostLink(email: string): Promise<string> {
  const token = freshToken();
  await original([["SET", lostLinkKey(token), email, "EX", 900]]);
  return token;
}
const confirmLost = (token: string) => lostConfirm(post("https://marktmorgen.com/api/auth/lost/confirm", { token }));

// ---- app/api/auth/lost/confirm --------------------------------------------------------------------------------

const LOST = "r24-lost@example.com";

test("lost/confirm: a link to the recovery address logs in (healthy control)", async () => {
  redis.clear();
  const response = await confirmLost(await lostLink(LOST));
  assert.equal(response.headers.get("location"), "https://marktmorgen.com/studio");
  assert.equal(await emailForSession(cookieOf(response, "nl_session")), LOST);
});

test("lost/confirm: a link already spent still says it expired (confirmed absence)", async () => {
  redis.clear();
  const token = await lostLink(LOST);
  await confirmLost(token);
  const again = await confirmLost(token);
  assert.equal(again.headers.get("location"), EXPIRED);
});

for (const [label, reply] of [["an object", {}], ["a number", 7], ["a list", ["x"]], ["undefined", undefined]] as [string, unknown][]) {
  test(`lost/confirm: a spent link whose two-step record reads as ${label} is not called expired`, async () => {
    redis.clear();
    const response = await withReply(isGet(recordKey(LOST)), reply, async () => confirmLost(await lostLink(LOST)));
    assert.equal(response.headers.get("location"), UNKNOWN_LOGIN);
    assert.equal(cookieOf(response, "nl_session"), undefined, "no session cookie");
    await noSessionsLeft();
  });
}

test("lost/confirm: a spent link whose session could not be opened is not called expired, and a fresh one logs in", async () => {
  redis.clear();
  const response = await withReply(sessionWrite, "QUEUED", async () => confirmLost(await lostLink(LOST)));
  assert.equal(response.headers.get("location"), UNKNOWN_LOGIN);
  assert.equal(cookieOf(response, "nl_session"), undefined, "no session cookie");
  await noSessionsLeft();
  const fresh = await confirmLost(await lostLink(LOST));
  assert.equal(fresh.headers.get("location"), "https://marktmorgen.com/studio");
  assert.equal(await emailForSession(cookieOf(fresh, "nl_session")), LOST);
});

// ---- app/api/auth/rescue ---------------------------------------------------------------------------------------

const RESCUED = "r24-rescued@example.com";

async function rescueLink(email: string): Promise<string> {
  await original([["SET", recordKey(email), record(["abcd-efgh", "jkmn-pqrs"])]]);
  const token = freshToken();
  await original([["SET", rescueKey(token), email, "EX", 900]]);
  return token;
}
const rescue = (token: string, cookie = "") => rescueRoute(post("https://marktmorgen.com/api/auth/rescue", { token }, cookie));

test("rescue: the link turns two-step login off and logs in (healthy control)", async () => {
  redis.clear();
  const response = await rescue(await rescueLink(RESCUED));
  assert.equal(response.headers.get("location"), "https://marktmorgen.com/studio#two-step");
  assert.equal(await emailForSession(cookieOf(response, "nl_session")), RESCUED);
  assert.equal(await twoStepOn(RESCUED), false);
});

test("rescue: a link already spent still says it expired (confirmed absence)", async () => {
  redis.clear();
  const token = await rescueLink(RESCUED);
  await rescue(token);
  assert.equal((await rescue(token)).headers.get("location"), EXPIRED);
});

test("rescue: a spend whose two-step record cannot be read is not called expired", async () => {
  redis.clear();
  const token = await rescueLink(RESCUED);
  const response = await withReply(isGet(recordKey(RESCUED)), {}, () => rescue(token));
  assert.equal(response.headers.get("location"), UNKNOWN_LOGIN);
  assert.equal(cookieOf(response, "nl_session"), undefined, "no session cookie");
  await noSessionsLeft();
});

test("rescue: two-step login turned off and a session that could not be opened is an honest redirect, not an error page", async () => {
  redis.clear();
  const response = await withReply(sessionWrite, "QUEUED", async () => rescue(await rescueLink(RESCUED), "nl_2fa=" + "b".repeat(64)));
  assert.equal(response.headers.get("location"), UNKNOWN_LOGIN);
  assert.equal(cookieOf(response, "nl_session"), undefined, "no session cookie");
  assert.equal(cookieOf(response, "nl_2fa"), "", "the waiting login's cookie is cleared");
  await noSessionsLeft();
  // Two-step login is off, so a fresh emailed link logs the person in without the app.
  assert.equal(await twoStepOn(RESCUED), false);
  const token = freshToken();
  await original([["SET", signInLinkKey(token), RESCUED, "EX", 900]]);
  const fresh = await callback(post("https://marktmorgen.com/api/auth/callback", { token }));
  assert.equal(await emailForSession(cookieOf(fresh, "nl_session")), RESCUED);
});

// ---- app/api/auth/code -----------------------------------------------------------------------------------------

const CODED = "r24-coded@example.com";
const sendCode = (held: string, code: string) => codeRoute(post("https://marktmorgen.com/api/auth/code", { code }, `nl_2fa=${held}`));

test("code: a right recovery code logs in (healthy control)", async () => {
  redis.clear();
  await original([["SET", recordKey(CODED), record(["abcd-efgh", "jkmn-pqrs"])]]);
  const response = await sendCode(await holdSignIn(CODED, false), "abcd-efgh");
  assert.equal(response.headers.get("location"), "https://marktmorgen.com/studio");
  assert.equal(await emailForSession(cookieOf(response, "nl_session")), CODED);
});

test("code: a right code whose session could not be opened is an honest redirect, and a fresh login finishes", async () => {
  redis.clear();
  await original([["SET", recordKey(CODED), record(["abcd-efgh", "jkmn-pqrs"])]]);
  const held = await holdSignIn(CODED, false);
  const response = await withReply(sessionWrite, "QUEUED", () => sendCode(held, "abcd-efgh"));
  assert.equal(response.headers.get("location"), UNKNOWN_LOGIN);
  assert.equal(cookieOf(response, "nl_session"), undefined, "no session cookie");
  assert.equal(cookieOf(response, "nl_2fa"), "", "the spent wait's cookie is cleared");
  await noSessionsLeft();
  // Two-step login stays on; a fresh wait and another code log in.
  assert.equal(await twoStepOn(CODED), true);
  const again = await sendCode(await holdSignIn(CODED, false), "jkmn-pqrs");
  assert.equal(again.headers.get("location"), "https://marktmorgen.com/studio");
  assert.equal(await emailForSession(cookieOf(again, "nl_session")), CODED);
});
