/**
 * #2674 LOW (Claude 1 / Claude 5): the inbox's essential counters (inbox-new for a
 * visitor's first message, inbox-reply for the team's answers) said "limited", too
 * many, when the count could not be read. A real excess stays "limited"; an
 * unreadable count is "error", said as one (rule 24). Nothing is kept or sent.
 *
 * Claude 6's MEDIUM on #2674 (7057694750): the sending key is one the synthetic Resend fixture knows
 * (tests/resend-fixture-credentials.ts), so "nothing sent" is the guard's work, and the team's notice of a new
 * message (inbox-tell, withinEssentialLimit) has its own cases: sent with room, not sent on an unreadable count,
 * while the visitor's message is still kept.
 */
import { readInbox, replyTo, startChat, writeToAffiliate } from "@/lib/inbox";
import { claimHandle, ensureStatsId, setInboxSetting, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_sending_only";
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

  part("A message the store writes to one of its affiliates (inbox-new, writeToAffiliate)");
  // #2674, Claude 7's LEVE (6889801109) and Codex X6 item 3: its own behavior test for the same count.
  const toAffiliate = () => writeToAffiliate(store, { email: "partner@example.org", name: "Partner" }, "A new banner is ready for you to share this month.", OWNER);
  mode = { scope: "inbox-new", how: "unknown" };
  is("an affiliate message on an unreadable count is an error, never 'too many'", await toAffiliate(), { ok: false, reason: "error" });
  mode = { scope: "inbox-new", how: "full" };
  is("an affiliate message past the day's count is limited, as before", await toAffiliate(), { ok: false, reason: "limited" });
  mode = null;
  await real([["DEL", ...filled]]);
  filled.clear();

  part("Telling the team of a new message (inbox-tell)");
  const beforeRoom = sent;
  const told = await chat("10.0.0.5");
  is("control: with room, the visitor's message is kept", told.ok, true);
  is("control: and the team is told by one email", sent - beforeRoom, 1);
  mode = { scope: "inbox-tell", how: "unknown" };
  const beforeUnknown = sent;
  const untold = await chat("10.0.0.6");
  is("the notice's count unreadable: the visitor's message is still kept", untold.ok, true);
  is("and no notice is sent on a count that cannot be read", sent - beforeUnknown, 0);
  mode = null;

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
