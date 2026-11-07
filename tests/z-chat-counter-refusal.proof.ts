import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/chat-summary/route";
import { CHAT_URL, reset, state } from "./chat-counter-admission-world";

const originalFetch = globalThis.fetch;
let refusedProvider = false;
let posts = 0, requestBytes = 0, commands = 0;
globalThis.fetch = (async (input, init) => {
  assert.equal(String(input), CHAT_URL, "no other supplier destination");
  assert.equal(init?.method, "POST");
  const bytes = Buffer.byteLength(String(init?.body));
  assert.ok(posts + 1 <= 20 && requestBytes + bytes <= 10_000, "admitted synthetic POST/byte ceilings");
  posts += 1; requestBytes += bytes;
  state.posts += 1;
  return new Response(null, { status: refusedProvider ? 404 : 204 });
}) as typeof fetch;

async function ask(url = CHAT_URL) {
  const before = state.commands.length;
  // The route performs at most two counter commands and one setting command
  // in this fixture; reserve that envelope before invoking it.
  assert.ok(commands + 3 <= 200, "admitted synthetic command ceiling");
  const response = await POST(new Request("https://example.com/api/store/chat-summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }) as NextRequest);
  const used = state.commands.length - before;
  assert.ok(used <= 3, "the route did not exceed its admitted fixture envelope");
  commands += used;
  return response;
}
const writes = () => state.commands.filter(c => ["SET", "DEL"].includes(String(c[0])) && String(c[1]).startsWith("nl:chatsum:"));

for (const mode of ["timeout", "malformed", "unconfigured"] as const) {
  test(`unknown counter ${mode} offers retry instead of blaming rate`, async () => {
    reset(); refusedProvider = false;
    if (mode === "timeout") state.throws = true;
    if (mode === "malformed") { state.override = true; state.reply = { result: "?" }; }
    if (mode === "unconfigured") state.configured = false;
    const response = await ask();
    const body = await response.json();
    console.log(JSON.stringify({ mode, status: response.status, error: body.error, posts: state.posts, writes: writes().length }));
    assert.equal(state.posts, 0);
    assert.equal(writes().length, 0);
    assert.equal(response.status, 503);
    assert.equal(body.error, "unavailable");
  });
}

test("confirmed exceeded counter retains its genuine rate refusal", async () => {
  reset(); refusedProvider = false; state.override = true; state.reply = [null, 11];
  const response = await ask();
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "rate_limited");
  assert.equal(state.posts, 0); assert.equal(writes().length, 0);
});

test("healthy save retains one supplier POST and one sealed setting", async () => {
  reset(); refusedProvider = false;
  assert.equal((await ask()).status, 200);
  assert.equal(state.posts, 1); assert.equal(writes().length, 1);
});

test("stop remains possible after ten refused supplier tests", async () => {
  reset(); refusedProvider = true;
  for (let i = 0; i < 10; i++) {
    const response = await ask();
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "refused");
  }
  const beforePosts = state.posts;
  const response = await ask("");
  console.log(JSON.stringify({ mode: "stop-after-refused", status: response.status, posts: state.posts, writes: writes().length }));
  assert.equal(response.status, 200);
  assert.equal(state.posts, beforePosts);
  assert.equal(writes().filter(c => c[0] === "DEL").length, 1);
});

after(() => {
  globalThis.fetch = originalFetch;
  console.log(JSON.stringify({ syntheticCommands: commands, syntheticPosts: posts, requestBytes, externalRequests: 0 }));
});
