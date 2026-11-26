/**
 * What one assistant message costs in database commands, measured through the real route (Claude 1 cloud R's MÉDIO on
 * #4073: the pool script now also reads and writes the month's "opened" mark, so ASSISTANT_MESSAGE_COMMANDS, a
 * review ceiling, must be shown to still cover a message).
 *
 * Every command the route sends is counted. A script (EVAL) counts as itself plus every redis.call in its text: there
 * are no loops in the scripts a message runs, so that is an upper bound of what Upstash bills inside it. The ceiling
 * holds when the most a message measured is at most the twenty its model call is priced with plus
 * ASSISTANT_MESSAGE_COMMANDS (lib/store-assistant-rules.ts).
 *
 * Synthetic: the in-memory Redis stand-in and a stand-in for the model.
 */
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/assistant/route";
import { addProduct, claimHandle, ensureStatsId, setAssistant, setAssistantPlan, setSubscription } from "@/lib/store";
import { ASSISTANT_MESSAGE_COMMANDS } from "@/lib/store-assistant-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Command = (string | number)[];
let counted = 0;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  for (const command of commands) counted += command[0] === "EVAL" ? 1 + (String(command[1]).match(/redis\.call\(/g) ?? []).length : 1;
  return real(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") return new Response("not found", { status: 404 });
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ status: "answer", reply: "Every file is a PDF." }) }], usage: { input_tokens: 3_000, output_tokens: 40 } }));
}) as typeof fetch;

/** The commands one message takes through the route, and whether it was answered. */
async function ask(token?: string): Promise<{ commands: number; ok: boolean; token?: string }> {
  counted = 0;
  const response = await POST(new Request("https://marktmorgen.com/api/store/assistant", {
    method: "POST",
    headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "x-forwarded-for": "198.51.100.7", "content-type": "application/json" },
    body: JSON.stringify({ handle: "cmdshop", action: "ask", text: "Is it a PDF?", ...(token ? { token } : {}) }),
  }) as NextRequest);
  const body = (await response.json()) as { ok: boolean; thread?: { token?: string } };
  return { commands: counted, ok: body.ok, token: body.thread?.token };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  const now = Date.now();
  const owner = "cmdshop@example.com";
  await claimHandle(owner, "cmdshop", "Command Shop", "Recipes.");
  await setSubscription(owner, { customerId: "cus_CmdShop0001", subscriptionId: "sub_CmdShopPlan1", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
  await ensureStatsId(owner);
  const made = await addProduct(owner, "Meal Planner", "A week of dinners.", "27", null);
  if (!made.ok) throw new Error("no product");
  await setAssistant(owner, { on: true, notes: "Every file is a PDF." });
  await setAssistantPlan(owner, { subscriptionId: "sub_CmdShop00001", active: true, period: paidPeriod(now), cancelsAtEnd: false, disputedAt: "" });

  part("One message, measured through the route");
  const first = await ask();
  is("the first message of the month is answered", first.ok, true);
  const second = await ask(first.token);
  is("a message in the same conversation is answered", second.ok, true);
  const most = Math.max(first.commands, second.commands);
  console.log(`  commands: first message ${first.commands}, next in the conversation ${second.commands}; ceiling ${20 + ASSISTANT_MESSAGE_COMMANDS}`);
  is("the most a message takes is inside the twenty its model call is priced with plus ASSISTANT_MESSAGE_COMMANDS", most <= 20 + ASSISTANT_MESSAGE_COMMANDS, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
