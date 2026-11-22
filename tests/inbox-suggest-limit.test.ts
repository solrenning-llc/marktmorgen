/**
 * The studio inbox's suggested answer (app/api/store/inbox/route.ts,
 * `{ action: "suggest" }`) sits under the same per-minute writing limit as
 * every other AI route in the studio (`withinEssentialLimit("ai", …,
 * AI_PER_MINUTE, 60)`), so a loop cannot fire the model faster than the other
 * writing tools allow. Issue #4051. The model is played by a stand-in for
 * `fetch`. What is checked:
 *
 *   - AI_PER_MINUTE suggestions in one minute are written;
 *   - the next one in the same minute is answered 429 "slow", and the model
 *     is not asked;
 *   - a minute later it is written again.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, setInboxSetting, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readInbox, startChat } from "@/lib/inbox";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { POST as INBOX } from "@/app/api/store/inbox/route";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_inbox_only_a_stand_in";
process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;

let asked = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "email_1" });
  if (url.hostname === "api.anthropic.com") {
    asked += 1;
    return json({ content: [{ type: "text", text: "The course has twelve lessons." }] });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "suggest-limit@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "suggestlimit", "Suggest Limit", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Suggest001", subscriptionId: "sub_Suggest001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setInboxSetting(OWNER, { chat: true, saved: [] });
  const store = (await storeForEmail(OWNER))!;
  const started = await startChat({ store, email: "visitor@example.com", name: "Visitor", text: "How many lessons does the course have?", ip: "10.0.0.1" });
  if (!started.ok) throw new Error("no conversation");
  const [conversation] = await readInbox(store.statsId!);
  const session = await openSession(OWNER);
  const suggest = () =>
    INBOX(new NextRequest("https://marktmorgen.com/api/store/inbox", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "suggest", id: conversation.id }) }));

  part("The per-minute writing limit");
  const statuses: number[] = [];
  for (let i = 0; i < AI_PER_MINUTE; i++) statuses.push((await suggest()).status);
  is(`${AI_PER_MINUTE} suggestions in one minute are written`, [statuses, asked], [Array(AI_PER_MINUTE).fill(200), AI_PER_MINUTE]);
  const over = await suggest();
  is("the next one in the same minute: 429 slow, and the model is not asked", [over.status, await over.json(), asked], [429, { ok: false, error: "slow" }, AI_PER_MINUTE]);
  advance(61_000);
  const later = await suggest();
  is("a minute later it is written again", [later.status, asked], [200, AI_PER_MINUTE + 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
