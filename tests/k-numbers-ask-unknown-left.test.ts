/**
 * "Ask your numbers" (app/api/store/numbers/ask) checks the month's AI jobs first. lib/ai.ts aiLeft throws
 * UnknownReplyError when the balance cannot be read (rule 24); the route turned that into 0 and answered "used":
 * "This month's AI jobs are used up", false for a creator with jobs left. An unknown balance is now 503, and
 * nothing is counted, read or asked. A balance read as 0 is still "used" (control). Audit of the API routes,
 * Claude 3 (cloud K), 11 November 2026. Synthetic store and Redis; no model call.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { aiMonthKey } from "@/lib/ai";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { POST as ask } from "@/app/api/store/numbers/ask/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input instanceof Request ? input.url : input)).hostname === "api.anthropic.com") modelCalls += 1;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
let odd: { key: string; reply: unknown } | null = null;
redis.pipeline = (async (batch: (string | number)[][]) => {
  const answers = await real(batch);
  if (!odd) return answers;
  return batch.map((c, i) => (c[0] === "GET" && c[1] === odd!.key ? odd!.reply : answers[i]));
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "k-ask-left@example.com";
  await claimHandle(owner, "kaskleft", "K Ask Left", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_KAskLeft00001", subscriptionId: "sub_KAskLeft00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const key = aiMonthKey(store, new Date())!;
  const session = await openSession(owner);
  const post = async () => {
    const response = await ask(new NextRequest("https://marktmorgen.com/api/store/numbers/ask", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ question: "Which channel brought the most money?" }) }));
    return { status: response.status, error: ((await response.json()) as { error?: string }).error };
  };

  part("The month's AI balance read in another shape: unknown, never \"used up\"");
  for (const [label, reply] of [["a word", "lots"], ["a number that is not a count", -3], ["an object", { n: 1 }]] as const) {
    odd = { key, reply };
    const got = await post();
    is(`${label}: never told the month's AI jobs are used up`, got.error === "used", false);
    is(`${label}: said not to be readable just now (503)`, got.status, 503);
  }
  odd = null;
  is("no model was asked on an unknown balance", modelCalls, 0);

  part("Control: a balance read as all used is still \"used\"");
  await redis.pipeline([["SET", key, "999999"]]);
  const used = await post();
  is("all used: \"used\"", [used.status, used.error], [400, "used"]);
  done();
}

void main();
