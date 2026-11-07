/**
 * The voice route (app/api/store/voice/route.ts) asks for this month's
 * summary of what customers say, an AI job, only after the per-minute AI
 * counter confirms the request fits (CX-123 rule 24; Codex Z's MEDIUM,
 * proof 6e484fea). Called as the studio calls it, with a real session, on
 * the in-memory store: when the counter's reply is empty, partial, of the
 * wrong shape or never comes, the route answers 429 before any work and the
 * model is never called; a confirmed count lets it through, and a confirmed
 * count past the limit is refused as before.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/voice/route";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const OWNER = "voicecounter@example.com";

/** The reply the per-minute AI counter gets instead of the real one, or "throw" for a counter that never answers. */
let counterReply: unknown = null;
let counterCalls = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:rl:ai:")) {
    counterCalls++;
    if (counterReply === "throw") throw new Error("the database did not answer");
    if (counterReply !== null) return counterReply;
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.anthropic.com") {
    modelCalls++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ themes: [] }) }] }));
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  await claimHandle(OWNER, "voicecounter", "Voice Counter", "Recipes.");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async () => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/voice", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: "{}" }));
    return { status: response.status, error: ((await response.json()) as { error?: string }).error };
  };

  for (const [label, reply] of [
    ["an empty reply", []],
    ["a partial reply", ["OK"]],
    ["a SET answered false", [false, 1]],
    ["a count that is null", ["OK", null]],
    ["a count written as text", ["OK", "1"]],
    ["a count of zero", ["OK", 0]],
    ["a reply that is not a list", { result: 1 }],
    ["a counter that never answers", "throw"],
  ] as const) {
    counterReply = reply;
    const [before, modelBefore] = [counterCalls, modelCalls];
    const answer = await call();
    is(`${label}: refused with 429 before any work, the model never called`, [answer.status, answer.error, counterCalls - before, modelCalls - modelBefore], [429, "slow", 1, 0]);
  }

  counterReply = null;
  const confirmed = await call();
  is("a confirmed count within the limit lets the request through to the summary", [confirmed.status !== 429, confirmed.error !== "slow"], [true, true]);

  counterReply = [null, AI_PER_MINUTE + 1];
  const past = await call();
  is("a confirmed count past the limit is refused as before", [past.status, past.error], [429, "slow"]);
  done();
}

void main();
