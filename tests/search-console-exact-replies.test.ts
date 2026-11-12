/**
 * CX-123 rule 24 on lib/search-console.ts: a Redis reply read only in its
 * exact shape. Taking our Search Console away (DEL of the kept refresh
 * token) is said as done only on a count; keeping a connection, or the
 * state of the consent page, only on "OK". Any other reply is unknown: the
 * route never says "disconnected" while the sealed token may still be kept
 * and read, and Google's consent page is never called "connected" when
 * nothing was confirmed kept. Synthetic operator, tokens and Redis only;
 * Google's answers are mocked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/operator/search-console/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { DEMO_STUDIO_ADMIN } from "@/lib/house-store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { SEARCH_CONSOLE_SCOPE, beginSearchConsole, disconnectSearchConsole, finishSearchConsole, searchConsoleStatus } from "@/lib/search-console";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret-for-tests";

const idToken = (email: string) =>
  `x.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: "client-id.apps.googleusercontent.com", exp: Math.floor(Date.now() / 1000) + 600, sub: "1234567890", email })).toString("base64url")}.y`;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token")
    return new Response(JSON.stringify({ access_token: "ya29.synthetic", refresh_token: "1//synthetic-refresh", scope: `openid email ${SEARCH_CONSOLE_SCOPE}`, id_token: idToken("site@example.test") }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** Answers the one command `name` on `key` with `reply` (the command itself is not run), everything else as the stand-in does. */
async function answering<T>(name: string, key: string, reply: unknown[], run: () => Promise<T>): Promise<{ result: T | "refused"; error: unknown; injected: boolean }> {
  const original = redis.pipeline;
  let injected = false;
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === name && commands[0][1] === key) {
      injected = true;
      return reply;
    }
    return original.call(redis, commands);
  };
  try {
    return { result: await run(), error: null, injected };
  } catch (error) {
    return { result: "refused", error, injected };
  } finally {
    redis.pipeline = original;
  }
}

async function connected(): Promise<void> {
  redis.clear();
  const state = new URL((await beginSearchConsole(DEMO_STUDIO_ADMIN))!).searchParams.get("state")!;
  assert.equal(await finishSearchConsole(state, "code-synthetic", DEMO_STUDIO_ADMIN), "connected");
  assert.equal((await searchConsoleStatus()).connected, true);
}

async function disconnectThroughRoute(): Promise<string> {
  const session = await openSession(DEMO_STUDIO_ADMIN);
  const body = new URLSearchParams({ action: "disconnect" });
  const response = await POST(new NextRequest("https://marktmorgen.com/api/operator/search-console", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${SESSION_COOKIE}=${session}` }, body: body.toString() }));
  return response.headers.get("location") ?? `status ${response.status}`;
}

test("control: a connection taken away is said as disconnected, and is gone", async () => {
  await connected();
  assert.match(await disconnectThroughRoute(), /gsc=disconnected/);
  assert.equal((await searchConsoleStatus()).connected, false);
});

test("control: taking away what was not there (a count of 0) is still disconnected", async () => {
  redis.clear();
  await disconnectSearchConsole();
  assert.match(await disconnectThroughRoute(), /gsc=disconnected/);
});

const unknownCounts: [string, unknown[]][] = [
  ["no reply", []],
  ["an empty slot", [undefined]],
  ["null", [null]],
  ["OK instead of a count", ["OK"]],
  ["true", [true]],
  ["a count below zero", [-1]],
  ["a fraction", [0.5]],
  ["a count as text", ["1"]],
  ["an extra reply", [1, 1]],
];

for (const [label, reply] of unknownCounts) {
  test(`taking the connection away answered as ${label} is not said as done`, async () => {
    await connected();
    const direct = await answering("DEL", "nl:gsc:conn", reply, () => disconnectSearchConsole());
    assert(direct.injected);
    assert.equal(direct.result, "refused", "disconnectSearchConsole must not resolve on an unknown reply");
    assert(direct.error instanceof UnknownReplyError);
    const routed = await answering("DEL", "nl:gsc:conn", reply, () => disconnectThroughRoute());
    assert(routed.injected);
    assert.doesNotMatch(String(routed.result), /gsc=disconnected/, "the operator is never told it is disconnected while the token may still be kept");
    assert.equal((await searchConsoleStatus()).connected, true, "the sealed token was not confirmed gone");
  });
}

const unknownOks: [string, unknown[]][] = [
  ["no reply", []],
  ["null", [null]],
  ["a count", [1]],
  ["QUEUED", ["QUEUED"]],
  ["an extra reply", ["OK", "OK"]],
];

test("control: a connection kept with OK is connected", async () => {
  await connected();
});

for (const [label, reply] of unknownOks) {
  test(`keeping the connection answered as ${label} is not called connected`, async () => {
    redis.clear();
    const state = new URL((await beginSearchConsole(DEMO_STUDIO_ADMIN))!).searchParams.get("state")!;
    const out = await answering("SET", "nl:gsc:conn", reply, () => finishSearchConsole(state, "code-synthetic", DEMO_STUDIO_ADMIN));
    assert(out.injected);
    assert.equal(out.result, "error");
  });

  test(`keeping the consent page's state answered as ${label} sends nobody to Google`, async () => {
    redis.clear();
    const original = redis.pipeline;
    let injected = false;
    redis.pipeline = async (commands) => {
      if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:gsc:state:")) {
        injected = true;
        return reply;
      }
      return original.call(redis, commands);
    };
    try {
      const url = await beginSearchConsole(DEMO_STUDIO_ADMIN).catch((error: unknown) => (error instanceof UnknownReplyError ? "refused" : `other: ${String(error)}`));
      assert(injected);
      assert.equal(url, "refused");
    } finally {
      redis.pipeline = original;
    }
  });
}
