/**
 * "Let me in without my app" (app/api/auth/code/route.ts, action=reset) when the
 * two-step record cannot be read (lib/two-step.ts enterLocked throws
 * UnknownReplyError before anything is written): the person is told that they
 * were not let in and that nothing changed, on a notice of its own. Before, they
 * were sent to `?status=unknown`, whose words ask for the code their app shows,
 * which a person without the app never typed (Claude 5 on #2896, LIGHT 3).
 *
 *   - the route answers `/signin/code?status=reset-unknown`, the wait is not spent;
 *   - the code page carries a `reset-unknown` notice that names no code;
 *   - with the wait gone, `reset-unknown` reads as a login not finished, never as
 *     an expired link (as `unknown` already does);
 *   - control: a code check that cannot be read still answers `unknown`.
 *
 * Synthetic records only; no email leaves.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { holdSignIn } from "@/lib/two-step";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const recordKey = (email: string) => `nl:2fa:${sha(`nimbus-2fa:${email}`).slice(0, 40)}`;
const holdKey = (token: string) => `nl:2fa:hold:${sha(`nimbus-2fa-hold:${token}`).slice(0, 40)}`;
const codeHash = (code: string) => sha(`nimbus-2fa-code:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`);
const record = JSON.stringify({ s: "synthetic-sealed-secret", since: 1, codes: [codeHash("abcd-efgh")], last: -1, reset: 0, backup: "" });

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);

function post(body: Record<string, string>, cookie: string): NextRequest {
  return new NextRequest("https://marktmorgen.com/api/auth/code", {
    method: "POST",
    body: new URLSearchParams(body),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  });
}

/** The record's GET answers `reply` (a shape no writer makes); every other command runs as usual. */
async function recordAnswers<T>(email: string, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Cmd[]) => {
    const out = await original(commands);
    return commands.map((cmd, i) => (cmd[0] === "GET" && cmd[1] === recordKey(email) ? reply : out[i]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

for (const [label, reply] of [["an object", {}], ["a number", 7], ["a list", ["x"]]] as [string, unknown][]) {
  test(`let in without the app, record read as ${label}: its own notice, and the wait is kept`, async () => {
    redis.clear();
    const who = `reset-unknown-${label.replace(/\W/g, "")}@example.com`;
    await original([["SET", recordKey(who), record]]);
    const token = await holdSignIn(who);
    const answer = await recordAnswers(who, reply, () => codeRoute(post({ action: "reset" }, `nl_2fa=${token}`)));
    assert.equal(answer.headers.get("location"), "https://marktmorgen.com/signin/code?status=reset-unknown");
    assert.equal((await original([["EXISTS", holdKey(token)]]))[0], 1, "nothing was spent");
  });
}

test("control: a code check that cannot be read still says the code could not be checked", async () => {
  redis.clear();
  const who = "reset-unknown-control@example.com";
  await original([["SET", recordKey(who), record]]);
  const token = await holdSignIn(who);
  const answer = await recordAnswers(who, {}, () => codeRoute(post({ code: "123456" }, `nl_2fa=${token}`)));
  assert.equal(answer.headers.get("location"), "https://marktmorgen.com/signin/code?status=unknown");
});

const page = readFileSync("app/signin/code/page.tsx", "utf8");

test("the code page has a reset-unknown notice that asks for no code", () => {
  const line = page.split("\n").find((l) => /^\s*"reset-unknown":/.test(l)) ?? "";
  assert.ok(line, "a reset-unknown notice is there");
  assert.match(line, /could not let you in/i);
  assert.match(line, /nothing was changed/i);
  assert.doesNotMatch(line, /code/i, "a person without the app is not asked for a code");
});

test("with the wait gone, reset-unknown reads as a login not finished, never as an expired link", () => {
  assert.match(page, /\["unknown", "reset-unknown"\]\.includes\(status\)\s*\?\s*"\/signin\?status=login-unknown"/);
});
