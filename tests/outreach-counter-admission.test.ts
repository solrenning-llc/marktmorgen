import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/outreach/route";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { redis, reset, state } from "./outreach-counter-admission-world";

const ask = (action: string) => POST(new Request("https://example.com/api/store/outreach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, goal: "sponsor", site: "https://example.com", country: "US", isCompany: true, notes: "A synthetic draft" }) }) as NextRequest);
let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
}
async function refused(action: "find" | "draft") {
  const response = await ask(action);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, error: action === "find" ? "day" : "slow" });
  assert.deepEqual([state.reads, state.drafts, state.serviceCalls, state.commands.length], [0, 0, 0, 2]);
}
async function main() {
  const sparse = new Array(2); sparse[1] = 1;
  for (const action of ["find", "draft"] as const) {
    for (const [name, reply] of [["missing", undefined], ["empty", []], ["partial", sparse], ["extra", ["OK", 1, true]], ["text", ["OK", "1"]], ["null", ["OK", null]], ["zero", ["OK", 0]], ["negative", ["OK", -1]], ["unknown SET", [false, 1]]] as [string, unknown][]) {
      await check(`${action} refuses ${name} counter before provider work`, async () => { reset(); state.override = true; state.reply = reply; await refused(action); });
    }
    await check(`${action} refuses a counter timeout`, async () => { reset(); state.throws = true; await refused(action); });
  }
  await check("confirmed daily counters preserve sixty reads and the original expiry", async () => {
    reset();
    for (let i = 0; i < 60; i += 1) { redis.advance(60_000); assert.equal((await ask("find")).status, 200); }
    assert.equal((await ask("find")).status, 429);
    assert.deepEqual([state.reads, state.drafts, state.serviceCalls], [60, 0, 60]);
    assert.match(String(state.commands[0][1]), /^nl:rl:outreach-find-day:[0-9a-f]{32}$/);
    assert.deepEqual(state.commands[0].slice(2), ["0", "EX", 86_400, "NX"]);
  });
  await check("confirmed AI counters preserve the existing minute limit", async () => {
    reset();
    for (let i = 0; i < AI_PER_MINUTE; i += 1) assert.equal((await ask("draft")).status, 200);
    assert.equal((await ask("draft")).status, 429);
    assert.deepEqual([state.reads, state.drafts, state.serviceCalls], [0, AI_PER_MINUTE, 0]);
    assert.match(String(state.commands[0][1]), /^nl:rl:ai:[0-9a-f]{32}$/);
    assert.deepEqual(state.commands[0].slice(2), ["0", "EX", 60, "NX"]);
  });
  await check("a confirmed daily counter does not bypass a monthly refusal", async () => {
    reset(); state.refusal = { reason: "used", message: "Confirmed monthly refusal" };
    const response = await ask("find"); assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { ok: false, error: "slow", message: "Confirmed monthly refusal" });
    assert.deepEqual([state.reads, state.drafts, state.serviceCalls], [0, 0, 1]);
  });
  await check("authorization refusal precedes the counters", async () => {
    reset(); state.authorized = false; assert.equal((await ask("find")).status, 403);
    assert.deepEqual([state.reads, state.drafts, state.commands.length], [0, 0, 0]);
  });
  await check("unrelated actions do not consume these counters", async () => {
    reset(); state.throws = true; assert.equal((await ask("unknown")).status, 400);
    assert.deepEqual([state.reads, state.drafts, state.commands.length], [0, 0, 0]);
  });
  console.log(`${passed} passed; ${failed} failed`); process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
