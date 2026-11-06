import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/stream/hook/route";
import { readKey, redis, reset, state } from "./stream-hook-counter-admission-world";

const payload = { VideoLibraryId: 123, VideoGuid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" };
const body = JSON.stringify(payload);
let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
function request(raw = body, ip = "198.51.100.1", valid = true) {
  const signature = createHmac("sha256", readKey).update(raw).digest("hex");
  return new Request("https://example.com/api/stream/hook", { method: "POST", headers: { "x-forwarded-for": ip, "x-bunnystream-signature-version": "v1", "x-bunnystream-signature-algorithm": "hmac-sha256", "x-bunnystream-signature": valid ? signature : "0".repeat(64) }, body: raw }) as NextRequest;
}
async function main() {
  for (const [label, reply] of [["missing", undefined], ["empty", []], ["partial", ["OK"]], ["extra", ["OK", 1, true]], ["numeric text", ["OK", "1"]], ["null", ["OK", null]], ["zero", ["OK", 0]], ["negative", ["OK", -1]], ["fraction", ["OK", 0.5]], ["unknown SET", [false, 1]]] as [string, unknown][]) {
    await check(`unknown ${label} stops before video and caption helpers`, async () => {
      reset(); state.inject = true; state.reply = reply;
      const response = await POST(request());
      if (response.status !== 429) console.log(JSON.stringify({ label, status: response.status, counterCommands: state.commands.length, videoHelperAttempts: state.heard, captionHelperAttempts: state.captions, fixtureHelperArgumentBytes: state.inputBytes }));
      assert.equal(response.status, 429);
      assert.deepEqual(await response.json(), { ok: false });
      assert.deepEqual([state.commands.length, state.heard, state.captions, state.inputBytes], [2, 0, 0, 0]);
    });
  }
  await check("counter timeout refuses without retry or readback", async () => {
    reset(); state.inject = true; state.throws = true;
    assert.equal((await POST(request())).status, 429);
    assert.deepEqual([state.commands.length, state.heard, state.captions], [2, 0, 0]);
  });
  await check("600 confirmed calls keep the existing minute ceiling, hashed key and TTL", async () => {
    reset();
    for (let i = 0; i < 600; i++) assert.equal((await POST(request())).status, 200);
    assert.equal((await POST(request())).status, 429);
    assert.deepEqual([state.heard, state.captions], [600, 600]);
    const hash = createHash("sha256").update("nimbus-stream-hook:198.51.100.1").digest("hex").slice(0, 32);
    assert.deepEqual(state.commands[0], ["SET", `nl:rl:stream-hook:${hash}`, "0", "EX", 60, "NX"]);
    assert.deepEqual(state.commands[1], ["INCR", `nl:rl:stream-hook:${hash}`]);
    redis.advance(61000);
    assert.equal((await POST(request())).status, 200);
  });
  await check("confirmed null SET acknowledgement is a valid existing key", async () => {
    reset(); state.inject = true; state.reply = [null, 1];
    assert.equal((await POST(request())).status, 200);
    assert.deepEqual([state.commands.length, state.heard, state.captions], [2, 1, 1]);
  });
  await check("committed lost acknowledgement consumes the increment", async () => {
    reset(); state.inject = true; state.commit = true; state.reply = [];
    assert.equal((await POST(request())).status, 429);
    state.inject = false;
    for (let i = 0; i < 599; i++) assert.equal((await POST(request())).status, 200);
    assert.equal((await POST(request())).status, 429);
    assert.deepEqual([state.heard, state.captions], [599, 599]);
  });
  await check("unconfigured service remains404 before counters", async () => {
    reset(); state.configured = false;
    assert.equal((await POST(request())).status, 404);
    assert.equal(state.commands.length, 0);
  });
  await check("actual HMAC verification still rejects a bad signature before helpers", async () => {
    reset(); assert.equal((await POST(request(body, "198.51.100.1", false))).status, 401);
    assert.deepEqual([state.commands.length, state.heard, state.captions], [2, 0, 0]);
  });
  await check("signed malformed JSON remains400 before helpers", async () => {
    reset(); assert.equal((await POST(request("{"))).status, 400);
    assert.deepEqual([state.heard, state.captions], [0, 0]);
  });
  await check("body ceiling still refuses before helpers", async () => {
    reset(); assert.equal((await POST(request("x".repeat(4001)))).status, 413);
    assert.deepEqual([state.heard, state.captions], [0, 0]);
  });
  await check("ignored video leaves captions untouched", async () => {
    reset(); state.result = "ignored";
    assert.deepEqual(await (await POST(request())).json(), { ok: true, result: "ignored" });
    assert.deepEqual([state.heard, state.captions], [1, 0]);
  });
  await check("provider-helper failure retains retryable500", async () => {
    reset(); state.providerThrows = true;
    assert.equal((await POST(request())).status, 500);
    assert.deepEqual([state.heard, state.captions], [1, 0]);
  });
  console.log(`${passed} passed; ${failed} failed`); process.exitCode = failed ? 1 : 0;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
