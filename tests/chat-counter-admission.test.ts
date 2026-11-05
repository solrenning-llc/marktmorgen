import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/chat-summary/route";
import { CHAT_URL, reset, state } from "./chat-counter-admission-world";

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
const ask = (body: Record<string, unknown> = { url: CHAT_URL }) => POST(new Request("https://example.com/api/store/chat-summary", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}) as NextRequest);
const settings = () => state.commands.filter(c => ["SET", "DEL"].includes(String(c[0])) && String(c[1]).startsWith("nl:chatsum:"));
const counters = () => state.commands.filter(c => String(c[1]).startsWith("nl:rl:chat-summary:"));
async function refused() {
  const response = await ask();
  console.log(JSON.stringify({ status: response.status, counterCommands: counters().length, posts: state.posts,
    postBytes: state.postBytes, settingCommands: settings().length,
    settingBytes: settings().reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c)), 0) }));
  assert.equal(response.status, 429);
  assert.equal(state.posts, 0);
  assert.equal(settings().length, 0);
}

async function main() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), CHAT_URL, "No other supplier URL allowed");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(typeof init?.body, "string");
    state.posts++; state.postBytes += Buffer.byteLength(init.body as string);
    return new Response(null, { status: 204 });
  };
  try {
    const inherited = Object.setPrototypeOf([, 1], { 0: "OK" });
    let getterCalls = 0;
    const getter = ["OK", 1];
    Object.defineProperty(getter, "1", { get() { getterCalls++; return 1; } });
    const malformed: [string, unknown][] = [
      ["missing", undefined], ["null", null], ["object", {}], ["empty", []], ["partial", ["OK"]],
      ["unknown SET", [false, 1]], ["null count", ["OK", null]], ["text count", ["OK", "1"]],
      ["zero", ["OK", 0]], ["negative", ["OK", -1]], ["NaN", ["OK", NaN]], ["infinite", ["OK", Infinity]],
      ["fraction", ["OK", 1.5]], ["unsafe", ["OK", Number.MAX_SAFE_INTEGER + 1]],
      ["extra", ["OK", 1, true]], ["sparse", [, 1]], ["inherited", inherited], ["getter", getter],
    ];
    for (const [name, reply] of malformed) await check(`unknown ${name} refuses before chat POST/write`, async () => {
      reset(); state.override = true; state.reply = reply;
      await refused(); assert.equal(counters().length, 2);
      if (name === "getter") assert.equal(getterCalls, 0);
    });
    await check("counter timeout refuses before actual chat POST/write", async () => {
      reset(); state.throws = true; await refused(); assert.equal(counters().length, 2);
    });
    await check("missing counter configuration refuses without commands", async () => {
      reset(); state.configured = false; await refused(); assert.equal(state.commands.length, 0);
    });
    await check("lost acknowledgement retains the committed counter", async () => {
      reset(); state.commitThenThrow = true; await refused(); state.commitThenThrow = false;
      for (let n = 2; n <= 10; n++) assert.equal((await ask()).status, 200);
      assert.equal((await ask()).status, 429);
      assert.equal(state.posts, 9); assert.equal(settings().length, 9);
      assert.equal(counters().length, 22);
    });
    await check("confirmed counter posts and seals once after exactly two counter commands", async () => {
      reset(); const response = await ask(); assert.equal(response.status, 200);
      assert.equal(state.posts, 1); assert.ok(state.postBytes > 0); assert.equal(settings().length, 1);
      assert.match(String(settings()[0][2]), /^s1\./);
      assert.deepEqual(counters().map(c => c[0]), ["SET", "INCR"]);
      assert.deepEqual(counters()[0].slice(2), ["0", "EX", 3600, "NX"]);
      assert.equal(counters()[0][1], counters()[1][1]);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    });
    await check("ten confirmed saves succeed and the eleventh refuses", async () => {
      reset(); for (let n = 1; n <= 10; n++) assert.equal((await ask()).status, 200);
      assert.equal((await ask()).status, 429); assert.equal(state.posts, 10); assert.equal(settings().length, 10);
    });
    await check("confirmed exceeded counter keeps its refusal", async () => {
      reset(); state.override = true; state.reply = [null, 11]; await refused();
    });
    await check("sales toggle remains outside provider-test counter", async () => {
      reset(); state.throws = true; assert.equal((await ask({ sales: true })).status, 200);
      assert.deepEqual([state.toggles, state.posts, state.commands.length], [1, 0, 0]);
    });
    await check("authorization refusal precedes counter and provider", async () => {
      reset(); state.authorized = false; assert.equal((await ask()).status, 403);
      assert.deepEqual([state.posts, state.commands.length], [0, 0]);
    });
    await check("invalid provider URL retains known refusal", async () => {
      reset(); assert.equal((await ask({ url: "https://example.com/not-a-webhook" })).status, 400);
      assert.equal(state.posts, 0); assert.equal(settings().length, 0);
    });
    await check("confirmed removal deletes the sealed address without a provider POST", async () => {
      reset(); assert.equal((await ask({ url: "" })).status, 200);
      assert.equal(state.posts, 0); assert.equal(settings().length, 1); assert.equal(settings()[0][0], "DEL");
      assert.equal(counters().length, 2);
    });
  } finally { globalThis.fetch = original; }
  console.log(`${passed} passed; ${failed} failed`); process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
