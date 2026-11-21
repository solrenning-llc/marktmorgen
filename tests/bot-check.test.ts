/**
 * Whether a request came from a program (lib/bot-check.ts): the host's word
 * for it is taken when it is given in time, and nothing else ever refuses.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { isAutomated } from "@/lib/bot-check";

const CONTEXT = Symbol.for("@vercel/request-context");
const KEYS = ["VERCEL", "NODE_ENV", "VERCEL_OIDC_TOKEN", "OVERRIDE_BOTID_SERVER_URL"] as const;

let server: Server;
let base = "";
/** What the stand-in for the host answers next, and after how long. */
let next: { body: string; status: number; after: number } = { body: "{}", status: 200, after: 0 };
let asked = 0;

before(async () => {
  server = createServer((request, response) => {
    asked += 1;
    request.resume();
    const { body, status, after: wait } = next;
    setTimeout(() => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(body);
    }, wait);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

/** Runs as if on the host, in production, with a request in hand. */
async function onHost(answer: Partial<typeof next>, env: Partial<Record<(typeof KEYS)[number], string>> = {}): Promise<boolean> {
  const env_ = process.env as Record<string, string | undefined>;
  const kept = Object.fromEntries(KEYS.map((key) => [key, env_[key]]));
  const world = globalThis as unknown as Record<symbol, unknown>;
  const context = world[CONTEXT];
  const { error, warn } = console;
  next = { body: "{}", status: 200, after: 0, ...answer };
  Object.assign(env_, { VERCEL: "1", NODE_ENV: "production", VERCEL_OIDC_TOKEN: "token", OVERRIDE_BOTID_SERVER_URL: base, ...env });
  world[CONTEXT] = {
    get: () => ({
      headers: { host: "marktmorgen.com", "x-is-human": "{}", "x-path": "/api/auth/request", "x-method": "POST" },
      url: "https://marktmorgen.com/api/auth/request",
      mutateResponseHeadersBeforeFlush: () => {},
    }),
  };
  console.error = () => {};
  console.warn = () => {};
  try {
    return await isAutomated();
  } finally {
    console.error = error;
    console.warn = warn;
    world[CONTEXT] = context;
    for (const key of KEYS) {
      if (kept[key] === undefined) delete env_[key];
      else env_[key] = kept[key];
    }
  }
}

test("off the host nothing is asked and nothing is refused", async () => {
  const before = asked;
  const kept = process.env.VERCEL;
  delete process.env.VERCEL;
  try {
    assert.equal(await isAutomated(), false);
  } finally {
    if (kept !== undefined) process.env.VERCEL = kept;
  }
  assert.equal(asked, before);
});

test("the host says a program sent it: refused", async () => {
  assert.equal(await onHost({ body: JSON.stringify({ isBot: true, isVerifiedBot: false, bypassed: false }) }), true);
});

test("the host says a person's browser sent it: let through", async () => {
  assert.equal(await onHost({ body: JSON.stringify({ isBot: false, isVerifiedBot: false, bypassed: false }) }), false);
});

test("an answer that is not a clear yes refuses nobody", async () => {
  assert.equal(await onHost({ body: JSON.stringify({ isBot: "yes" }) }), false);
  assert.equal(await onHost({ body: "{}" }), false);
});

test("the host answers with something that is not JSON: let through", async () => {
  assert.equal(await onHost({ body: "<html>bad gateway</html>", status: 502 }), false);
});

test("the host cannot be reached: let through", async () => {
  assert.equal(await onHost({}, { OVERRIDE_BOTID_SERVER_URL: "http://127.0.0.1:9" }), false);
});

test("the host is slow: let through within three seconds, not held", async () => {
  const started = Date.now();
  assert.equal(await onHost({ body: JSON.stringify({ isBot: true }), after: 4_000 }), false);
  const took = Date.now() - started;
  assert.ok(took >= 2_400 && took < 3_500, `took ${took} ms`);
});

test("asking for a login link is checked after the limit per machine and before anything is sent", () => {
  const route = readFileSync(join(process.cwd(), "app/api/auth/request/route.ts"), "utf8");
  const limit = route.indexOf("rateLimitAnswer(ip)");
  const check = route.indexOf("await isAutomated()");
  const address = route.indexOf("addressLimitAnswer(email)");
  const send = route.indexOf("sendSignInLink(email");
  assert.ok(limit > 0 && check > limit, "the check comes after the limit per machine");
  assert.ok(address > check && send > address, "and before the address is counted or written to");
  assert.match(route, /error: "unconfirmed" \}, \{ status: 403 \}/);
});

test("the form sends its request with the challenge, and without it if the challenge cannot load", () => {
  const form = readFileSync(join(process.cwd(), "components/signin-form.tsx"), "utf8");
  // The check is set up once for the window, with the store's counts too (lib/browser-check-client.ts).
  assert.match(form, /plainFetch = startBrowserCheck\(\)/);
  const client = readFileSync(join(process.cwd(), "lib/browser-check-client.ts"), "utf8");
  assert.match(client, /\{ path: "\/api\/auth\/request", method: "POST" \}/);
  assert.match(form, /return ask\(plainFetch\)/);
  assert.match(form, /unconfirmed:/);
  const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  assert.match(config, /export default withBotId\(nextConfig\)/);
});
