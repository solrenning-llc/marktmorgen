import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { POST as ask } from "@/app/api/store/ask/route";
import { POST as guide } from "@/app/api/store/guide/route";
import { ASKS_PER_TEN_MINUTES, ASKS_PER_DAY, STORE_ASKS_PER_MINUTE } from "@/lib/answers-rules";
import { redis, reset, state } from "./visitor-ai-counter-admission-world";

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
const handlers = [["ask", ask], ["guide", guide]] as const;
const scopes = ["ask", "ask-day", "ask-store"] as const;
function request(ip = "198.51.100.1", origin = "https://example.com", body?: string) {
  return new Request("https://example.com/api/store/visitor", { method: "POST", headers: { host: "example.com", origin, "x-forwarded-for": ip, "content-type": "application/json" }, body: body ?? JSON.stringify({ handle: "visitor-fixture", product: "p_fixture", question: "What is included?", goal: "Find a course" }) }) as NextRequest;
}
async function main() {
  for (const [route, handler] of handlers) {
    for (const [stage, scope] of scopes.entries()) {
      for (const [label, reply] of [["missing", undefined], ["empty", []], ["partial", ["OK"]], ["extra", ["OK", 1, true]], ["text", ["OK", "1"]], ["null", ["OK", null]], ["zero", ["OK", 0]], ["negative", ["OK", -1]], ["fraction", ["OK", 0.5]], ["unknown SET", [false, 1]]] as [string, unknown][]) {
        await check(`${route}/${scope} refuses ${label} before data/model work`, async () => {
          reset(); state.scope = scope; state.reply = reply;
          const response = await handler(request());
          if (response.status !== 503) console.log(JSON.stringify({ route, scope, label, commands: state.commands.length, fixtureReadCalls: state.reads, fixtureReadBytes: state.readBytes, modelHelperAttempts: state.models }));
          assert.equal(response.status, 503);
          assert.deepEqual(await response.json(), { ok: false, error: "try again in a moment" });
          assert.deepEqual([state.models, state.reads, state.readBytes, state.commands.length], [0, 0, 0, 2 * (stage + 1)]);
        });
      }
      await check(`${route}/${scope} refuses timeout without retry or readback`, async () => {
        reset(); state.scope = scope; state.throws = true;
        assert.equal((await handler(request())).status, 503);
        assert.deepEqual([state.models, state.reads, state.commands.length], [0, 0, 2 * (stage + 1)]);
      });
    }
    await check(`${route} keeps the confirmed minute ceiling, keys and TTLs`, async () => {
      reset();
      for (let i = 0; i < ASKS_PER_TEN_MINUTES; i++) assert.equal((await handler(request())).status, 200);
      assert.equal((await handler(request())).status, 429);
      assert.equal(state.models, ASKS_PER_TEN_MINUTES);
      for (const [index, scope, ttl] of [[0, "ask", 600], [2, "ask-day", 86400], [4, "ask-store", 60]] as const) {
        assert.match(String(state.commands[index][1]), new RegExp(`^nl:rl:${scope}:[0-9a-f]{32}$`));
        assert.deepEqual(state.commands[index].slice(2), ["0", "EX", ttl, "NX"]);
      }
    });
    await check(`${route} keeps the confirmed daily ceiling across minute windows`, async () => {
      reset();
      for (let i = 0; i < ASKS_PER_DAY; i++) { if (i % ASKS_PER_TEN_MINUTES === 0) redis.advance(601000); assert.equal((await handler(request())).status, 200); }
      redis.advance(601000);
      assert.equal((await handler(request())).status, 429);
      assert.equal(state.models, ASKS_PER_DAY);
    });
    await check(`${route} keeps the confirmed store ceiling across visitors`, async () => {
      reset();
      for (let i = 0; i < STORE_ASKS_PER_MINUTE; i++) assert.equal((await handler(request(`198.51.100.${i + 1}`))).status, 200);
      assert.equal((await handler(request("198.51.100.254"))).status, 429);
      assert.equal(state.models, STORE_ASKS_PER_MINUTE);
    });
    await check(`${route} consumes a committed increment with lost acknowledgement`, async () => {
      reset(); state.scope = "ask"; state.commit = true; state.reply = [];
      assert.equal((await handler(request())).status, 503);
      state.scope = "";
      for (let i = 0; i < ASKS_PER_TEN_MINUTES - 1; i++) assert.equal((await handler(request())).status, 200);
      assert.equal((await handler(request())).status, 429);
      assert.equal(state.models, ASKS_PER_TEN_MINUTES - 1);
    });
    await check(`${route} rejects cross-origin before counters`, async () => {
      reset(); assert.equal((await handler(request("198.51.100.1", "https://elsewhere.example"))).status, 403);
      assert.deepEqual([state.models, state.reads, state.commands.length], [0, 0, 0]);
    });
    await check(`${route} rejects invalid body before counters`, async () => {
      reset(); assert.equal((await handler(request("198.51.100.1", "https://example.com", "{"))).status, 400);
      assert.deepEqual([state.models, state.reads, state.commands.length], [0, 0, 0]);
    });
    await check(`${route} keeps unknown store and sales gate ordering`, async () => {
      reset(); state.found = false; assert.equal((await handler(request())).status, 404);
      reset(); state.sellable = false; assert.equal((await handler(request())).status, 400);
      assert.deepEqual([state.models, state.reads, state.commands.length], [0, 0, 0]);
    });
  }
  await check("ask retains its disabled answers gate", async () => {
    reset(); state.enabled = false; assert.equal((await ask(request())).status, 400);
    assert.deepEqual([state.models, state.reads, state.commands.length], [0, 0, 0]);
  });
  console.log(`${passed} passed; ${failed} failed`); process.exitCode = failed ? 1 : 0;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
