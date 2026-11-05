import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { POST as voice } from "@/app/api/store/voice/route";
import { POST as reviews } from "@/app/api/store/review-summary/route";
import { POST as numbers } from "@/app/api/store/numbers/ask/route";
import { reset, state } from "./z-occupied-ai-counter-world";

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
}
async function main() {
  for (const [name, route] of [["voice", voice], ["reviews", reviews], ["numbers", numbers]] as const) {
    const ask = () => route(new Request("https://example.com/api/store/synthetic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "What changed?", product: "p1234" }) }) as NextRequest);
    for (const [label, reply, throws] of [["empty", [], false], ["partial", ["OK"], false], ["unknown SET", [false, 1], false], ["null count", ["OK", null], false], ["text count", ["OK", "1"], false], ["timeout", [], true]] as const) {
      await check(`${name} refuses ${label} before supplier helper`, async () => {
        reset(reply, throws); const response = await ask();
        console.log(JSON.stringify({ route: name, reply: label, status: response.status, commands: state.commands.length, helpers: state.helpers, reads: state.reads, allowances: state.allowances }));
        assert.equal(state.commands.length, 2);
        assert.equal(response.status, 429);
        assert.deepEqual([state.helpers, state.reads, state.allowances], [0, 0, 0]);
      });
    }
    await check(`${name} accepts a confirmed counter`, async () => {
      reset(["OK", 1]); assert.equal((await ask()).status, 200); assert.equal(state.helpers, 1); assert.equal(state.commands.length, 2);
    });
    await check(`${name} preserves a confirmed exceeded limit`, async () => {
      reset([null, 7]); assert.equal((await ask()).status, 429); assert.deepEqual([state.helpers, state.reads, state.allowances], [0, 0, 0]);
    });
  }
  console.log(`${passed} passed; ${failed} failed`); process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
