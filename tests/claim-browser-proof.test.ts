/**
 * TODOS-51 C: a store is made (app/api/store/claim) only for a request the host does not call a program's
 * (lib/bot-check.ts, Vercel BotID at its basic level). The host saying "a program" refuses before anything is
 * written; a host that is slow, down or unclear refuses nobody, as for the login link, and the five stores an account
 * may run still bound it. The studio's form (components/handle-form.tsx) sends the request with the challenge.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import "./redis-stub";
import { store as redis } from "./redis-stub";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { storeForEmail } from "@/lib/store";
import { POST } from "@/app/api/store/claim/route";

const CONTEXT = Symbol.for("@vercel/request-context");
const KEYS = ["VERCEL", "NODE_ENV", "VERCEL_OIDC_TOKEN", "OVERRIDE_BOTID_SERVER_URL"] as const;
let server: Server;
let base = "";
let next = { body: "{}", status: 200 };

before(async () => {
  server = createServer((request, response) => {
    request.resume();
    response.writeHead(next.status, { "Content-Type": "application/json" });
    response.end(next.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** Asks for a store as `email`, as if on the host with the host answering `answer`. */
async function claim(email: string, handle: string, answer: { body: string; status?: number } | null): Promise<Response> {
  const session = await openSession(email);
  const env = process.env as Record<string, string | undefined>;
  const kept = Object.fromEntries(KEYS.map((key) => [key, env[key]]));
  const world = globalThis as unknown as Record<symbol, unknown>;
  const context = world[CONTEXT];
  const { error, warn } = console;
  next = { body: "{}", status: 200, ...(answer ?? {}) };
  Object.assign(env, { VERCEL: "1", NODE_ENV: "production", VERCEL_OIDC_TOKEN: "token", OVERRIDE_BOTID_SERVER_URL: answer ? base : "http://127.0.0.1:9" });
  world[CONTEXT] = {
    get: () => ({
      headers: { host: "marktmorgen.com", "x-is-human": "{}", "x-path": "/api/store/claim", "x-method": "POST" },
      url: "https://marktmorgen.com/api/store/claim",
      mutateResponseHeadersBeforeFlush: () => {},
    }),
  };
  console.error = () => {};
  console.warn = () => {};
  try {
    const body = JSON.stringify({ handle, name: "Proof shop", bio: "" });
    return await POST(new NextRequest("https://marktmorgen.com/api/store/claim", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "content-length": String(body.length), "sec-fetch-site": "same-origin", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` },
    }));
  } finally {
    console.error = error;
    console.warn = warn;
    world[CONTEXT] = context;
    for (const key of KEYS) {
      if (kept[key] === undefined) delete env[key];
      else env[key] = kept[key];
    }
  }
}

test("the host says a program sent it: refused, and no store is made", async () => {
  redis.clear();
  const response = await claim("bot-proof@example.com", "botproofshop", { body: JSON.stringify({ isBot: true, isVerifiedBot: false, bypassed: false }) });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: "unconfirmed" });
  assert.equal(await storeForEmail("bot-proof@example.com"), null);
});

test("the host says a person's browser sent it: the store is made", async () => {
  redis.clear();
  const response = await claim("person-proof@example.com", "personproofshop", { body: JSON.stringify({ isBot: false, isVerifiedBot: false, bypassed: false }) });
  assert.equal(response.status, 200);
  assert.notEqual(await storeForEmail("person-proof@example.com"), null);
});

test("the host cannot be reached: nobody is refused, the store is made", async () => {
  redis.clear();
  const response = await claim("down-proof@example.com", "downproofshop", null);
  assert.equal(response.status, 200);
  assert.notEqual(await storeForEmail("down-proof@example.com"), null);
});

test("the studio's form sends the request with the challenge", () => {
  const form = readFileSync(join(process.cwd(), "components/handle-form.tsx"), "utf8");
  assert.match(form, /initBotId\(\{ protect: \[\{ path: "\/api\/store\/claim", method: "POST" \}\] \}\)/);
  const route = readFileSync(join(process.cwd(), "app/api/store/claim/route.ts"), "utf8");
  assert.ok(route.indexOf("await isAutomated()") > 0 && route.indexOf("await isAutomated()") < route.indexOf("claimHandle(email"), "checked before the store is made");
});
