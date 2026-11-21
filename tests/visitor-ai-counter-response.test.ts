import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { POST as ask } from "@/app/api/store/ask/route";
import { POST as guide } from "@/app/api/store/guide/route";
import { reset, state } from "./visitor-ai-counter-admission-world";

const handlers = [["ask", ask], ["guide", guide]] as const;

function request() {
  return new Request("https://example.com/api/store/visitor", {
    method: "POST",
    headers: {
      host: "example.com",
      origin: "https://example.com",
      "x-forwarded-for": "198.51.100.1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      handle: "visitor-fixture",
      product: "p_fixture",
      question: "What is included?",
      goal: "Find a course",
    }),
  }) as NextRequest;
}

let passed = 0;
let failed = 0;

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`, error);
  }
}

async function main() {
  for (const [route, handler] of handlers) {
    for (const [label, configure] of [
      ["timeout", () => { state.throws = true; }],
      ["malformed acknowledgement", () => { state.reply = [false, 1]; }],
    ] as const) {
      await check(`${route} does not describe an unknown counter as a confirmed slowdown after ${label}`, async () => {
        reset();
        state.scope = "ask";
        configure();

        const response = await handler(request());
        const body = await response.json() as { error?: unknown };

        assert.notEqual(response.status, 429);
        assert.notEqual(body.error, "slow");
        assert.ok(response.status === 502 || response.status === 503);
        assert.deepEqual([state.models, state.reads], [0, 0]);
      });
    }
  }

  console.log(`${passed} passed; ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
