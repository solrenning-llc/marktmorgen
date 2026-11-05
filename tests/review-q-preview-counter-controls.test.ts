import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/store/preview/route";
import { replyWith, resetReview, reviewState, state } from "./review-q-preview-counter-world";

const ask = () => GET(new NextRequest("https://example.com/api/store/preview?handle=test-preview&product=p1234", {
  headers: { "x-forwarded-for": "198.51.100.3" },
}));
const downstream = () => [state.lookups, state.publicCalls, state.listings, state.copies, state.serves];
let passed = 0;
let failed = 0;

async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
}

async function refused() {
  const response = await ask();
  assert.equal(response.status, 429);
  assert.deepEqual(downstream(), [0, 0, 0, 0, 0]);
}

async function lostReplyIsConsumed(mode: "empty" | "throw") {
  resetReview();
  reviewState.afterCommit = mode;
  await refused();
  reviewState.afterCommit = "reply";
  for (let index = 0; index < 29; index += 1) assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 429);
  assert.deepEqual(downstream(), [29, 29, 29, 29, 29]);
  assert.equal(state.commands.length, 62, "the uncertain committed increment is not retried or read back");
}

async function main() {
  await check("missing Redis configuration refuses before any work", async () => {
    resetReview(); reviewState.configured = false; await refused(); assert.equal(state.commands.length, 0);
  });
  await check("an empty reply lost after commit stays consumed", () => lostReplyIsConsumed("empty"));
  await check("an exception after commit stays consumed", () => lostReplyIsConsumed("throw"));
  await check("an inherited SET slot is refused", async () => {
    resetReview();
    const reply: unknown[] = new Array(2); reply[1] = 1;
    Object.setPrototypeOf(reply, Object.assign(Object.create(Array.prototype), { 0: "OK" }));
    replyWith(reply); await refused(); assert.equal(state.commands.length, 2);
  });
  await check("an accessor count is refused without executing it", async () => {
    resetReview(); let reads = 0; const reply: unknown[] = [null, 1];
    Object.defineProperty(reply, "1", { configurable: true, enumerable: true, get() { reads += 1; return 1; } });
    replyWith(reply); await refused(); assert.equal(reads, 0); assert.equal(state.commands.length, 2);
  });
  for (const [name, count] of [["NaN", Number.NaN], ["infinity", Number.POSITIVE_INFINITY], ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["boolean", true]] as const) {
    await check(`${name} count is refused`, async () => {
      resetReview(); replyWith([null, count]); await refused(); assert.equal(state.commands.length, 2);
    });
  }
  await check("a confirmed first increment with a null SET result is admitted", async () => {
    resetReview(); replyWith([null, 1]); const response = await ask();
    assert.equal(response.status, 200); assert.deepEqual(downstream(), [1, 1, 1, 1, 1]); assert.equal(state.commands.length, 2);
  });
  console.log(`${passed} passed; ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
