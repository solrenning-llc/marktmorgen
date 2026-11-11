import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/ai/route";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { reset, state } from "./ai-counter-admission-world";

const ask = () => POST(new Request("https://example.com/api/store/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "bio", notes: "A synthetic draft" }) }) as NextRequest);
let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
}
async function refused() {
  const response = await ask();
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, error: "slow" });
  assert.equal(state.modelCalls, 0);
  assert.equal(state.commands.length, 2, "one counter attempt, no retry or readback");
}
async function main() {
  const sparse = new Array(2); sparse[1] = 1;
  for (const [name, reply] of [
    ["missing", undefined], ["empty", []], ["partial SET", sparse],
    ["extra", ["OK", 1, "extra"]], ["text", ["OK", "1"]],
    ["null", ["OK", null]], ["negative", ["OK", -1]],
    ["zero", ["OK", 0]], ["fractional", ["OK", 0.5]], ["unknown SET", [false, 1]],
  ] as [string, unknown][]) {
    await check(`AI route refuses ${name} acknowledgment before the model`, async () => {
      reset(); state.override = true; state.reply = reply; await refused();
    });
  }
  await check("AI route refuses a counter timeout", async () => { reset(); state.throws = true; await refused(); });
  await check("missing Redis never reaches the model", async () => {
    reset(); state.configured = false;
    assert.equal((await ask()).status, 429);
    assert.deepEqual([state.modelCalls, state.commands.length], [0, 0]);
  });
  await check("confirmed counters preserve the original minute limit and draft response", async () => {
    reset();
    for (let i = 0; i < AI_PER_MINUTE; i += 1) {
      const response = await ask(); assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, value: "A confirmed synthetic draft.", left: 9 });
    }
    assert.equal((await ask()).status, 429);
    assert.equal(state.modelCalls, AI_PER_MINUTE);
    assert.equal(state.commands.length, 2 * (AI_PER_MINUTE + 1));
    assert.match(String(state.commands[0][1]), /^nl:rl:ai:[0-9a-f]{32}$/);
    assert.deepEqual(state.commands[0].slice(2), ["0", "EX", 60, "NX"]);
    assert.deepEqual([state.permission, state.bodyLimit], ["page", 280_000]);
  });
  await check("authorization refusal stays before counters and model work", async () => {
    reset(); state.authorized = false;
    assert.equal((await ask()).status, 403);
    assert.deepEqual([state.modelCalls, state.commands.length], [0, 0]);
  });
  console.log(`${passed} passed; ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
