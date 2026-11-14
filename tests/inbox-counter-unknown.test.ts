/**
 * #2674 LOW (Claude 1 / Claude 5): the inbox's essential counters (inbox-new for a
 * visitor's first message, inbox-reply for the team's answers) said "limited", too
 * many, when the count could not be read. A real excess stays "limited"; an
 * unreadable count is "error", said as one (rule 24). Nothing is kept or sent.
 */
import { readInbox, replyTo, startChat } from "@/lib/inbox";
import { claimHandle, ensureStatsId, setInboxSetting, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_inbox_counter_only";
let sent = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST") { sent += 1; return new Response(JSON.stringify({ id: `email_${sent}` })); }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

type Mode = "full" | "unknown";
const real = redis.pipeline.bind(redis);
let mode: { scope: string; how: Mode } | null = null;
const filled = new Set<string>();
redis.pipeline = (async (commands: (string | number)[][]) => {
  const hit = mode && commands.find((c) => String(c[1] ?? "").startsWith(`nl:rl:${mode!.scope}:`));
  if (hit && mode!.how === "unknown") throw new Error("Redis timed out (synthetic)");
  if (hit) { filled.add(String(hit[1])); await real([["SET", String(hit[1]), "1000000000", "EX", 86_400]]); }
  return real(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "inboxcounter@example.com";
  await claimHandle(OWNER, "inboxcounter", "Inbox Counter", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_InboxCnt01", subscriptionId: "sub_InboxCnt01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setInboxSetting(OWNER, { chat: true, saved: [] });
  const store = (await storeForEmail(OWNER))!;
  const chat = (ip: string) => startChat({ store, email: "lee@example.org", name: "Lee", text: "Is the course still open this month?", ip });

  part("A visitor's first message (inbox-new)");
  mode = { scope: "inbox-new", how: "unknown" };
  is("an unreadable count is an error, never 'too many'", await chat("10.0.0.2"), { ok: false, reason: "error" });
  mode = { scope: "inbox-new", how: "full" };
  is("past the day's new conversations it is limited, as before", await chat("10.0.0.3"), { ok: false, reason: "limited" });
  mode = null;
  await real([["DEL", ...filled]]);
  filled.clear();

  part("The team's answer (inbox-reply)");
  const started = await chat("10.0.0.4");
  if (!started.ok) throw new Error("setup: a conversation");
  const conversation = (await readInbox(store.statsId))[0]?.id ?? "";
  is("(setup) the conversation is kept", conversation.length > 0, true);
  mode = { scope: "inbox-reply", how: "unknown" };
  const unknownReply = await replyTo(store, conversation, OWNER, "Yes, it is open until the end of the month.");
  is("an unreadable count is an error, never 'too many'", unknownReply.ok ? "ok" : unknownReply.reason, "error");
  mode = { scope: "inbox-reply", how: "full" };
  const fullReply = await replyTo(store, conversation, OWNER, "Yes, it is open until the end of the month.");
  is("past the day's answers it is limited, as before", fullReply.ok ? "ok" : fullReply.reason, "limited");
  mode = null;
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
