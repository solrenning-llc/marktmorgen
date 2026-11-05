/**
 * The same pattern as the voice route (CX-123 rules 24 and 30, after Codex
 * Z's MEDIUM, proof 6e484fea): the studio's help assistant
 * (app/api/store/help/route.ts) and the Path's wording
 * (app/api/store/path/route.ts, action "wording") go on to their AI work
 * only after the per-minute AI counter confirms the request fits. Called as
 * the studio calls them, with a real session, on the in-memory store: an
 * empty, partial, wrongly shaped or missing counter reply answers 429
 * before any work and the model is never called; a confirmed count lets
 * the request through, and a confirmed count past the limit is refused.
 */
import { NextRequest } from "next/server";
import { POST as help } from "@/app/api/store/help/route";
import { POST as path } from "@/app/api/store/path/route";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const OWNER = "helpcounter@example.com";

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
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ answer: "Open Products and choose Add a product.", sources: [] }) }] }));
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  await claimHandle(OWNER, "helpcounter", "Help Counter", "Recipes.");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const routes = [
    ["help", help, "https://marktmorgen.com/api/store/help", { question: "How do I add a product to my store?" }],
    ["path wording", path, "https://marktmorgen.com/api/store/path", { action: "wording", mission: "x" }],
  ] as const;
  for (const [name, route, url, body] of routes) {
    const call = async () => {
      const response = await route(new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify(body) }));
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
      is(`${name}, ${label}: refused with 429 before any work, the model never called`, [answer.status, answer.error, counterCalls - before, modelCalls - modelBefore], [429, "slow", 1, 0]);
    }
    counterReply = null;
    const confirmed = await call();
    is(`${name}: a confirmed count within the limit lets the request through`, [confirmed.status !== 429, confirmed.error !== "slow"], [true, true]);
    counterReply = [null, AI_PER_MINUTE + 1];
    const past = await call();
    is(`${name}: a confirmed count past the limit is refused as before`, [past.status, past.error], [429, "slow"]);
  }
  done();
}

void main();
