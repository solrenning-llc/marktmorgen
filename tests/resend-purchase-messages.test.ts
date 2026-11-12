import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

// #2674: every refusal the "send the purchase email again" route can answer must have its own
// words in the studio. An unknown code falls back to "Sending could not be confirmed. Check with
// the buyer", which is untrue when the route refused before anything was sent (VR item 2).
const route = readFileSync("app/api/store/resend/route.ts", "utf8");
const component = readFileSync("components/resend-purchase.tsx", "utf8");

const literalCodes = [...route.matchAll(/ok: false, error: "([a-z_]+)"/g)].map((m) => m[1]);
const answerCodes = [...(route.match(/const ANSWERS[^{]*\{([^}]*)\}/)?.[1] ?? "").matchAll(/([a-z_]+):/g)].map((m) => m[1]);
const messagesBlock = component.match(/const MESSAGES[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? "";
const componentCodes = new Set([...messagesBlock.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]));
const shown = (code: string) => componentCodes.has(code) || Object.prototype.hasOwnProperty.call(STUDIO_MESSAGES, code);

test("the route's refusal codes were read from its source", () => {
  assert.ok(literalCodes.includes("unavailable"), `codes: ${literalCodes.join(", ")}`);
  assert.ok(answerCodes.length >= 4, `ANSWERS codes: ${answerCodes.join(", ")}`);
});

test("every refusal code of the resend route has its own studio message", () => {
  const missing = [...new Set([...literalCodes, ...answerCodes])].filter((code) => !shown(code));
  assert.deepEqual(missing, []);
});

test("an unreadable count says nothing was sent, not that sending is uncertain", () => {
  const line = messagesBlock.split("\n").find((l) => /^\s+unavailable:/.test(l)) ?? "";
  assert.match(line, /nothing was sent/);
  assert.doesNotMatch(line, /Check with the buyer/);
});
