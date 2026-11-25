/**
 * #2674, Claude 6's MEDIUM 1, second part (7057694750, re-checked in 7106275399): the routes that answer the
 * inbox's essential counts say an unreadable count as unavailable (503) and a real excess as too many (429),
 * through the real route handlers, not by reading their source.
 *
 * - The store chat (app/api/store/chat/route.ts, action "start"): a visitor's first message, counted by inbox-new.
 * - The studio inbox (app/api/store/inbox/route.ts, action "reply"): the team's answer, counted by inbox-reply.
 * - The team's notice of a new message (lib/inbox.ts tellTeam, inbox-tell): one email with room, none while the
 *   half-hour window is full, none on an unreadable count; the visitor's message is kept every time.
 *
 * Synthetic store, Redis stub and Resend fixture only; nothing real is sent.
 */
import { NextRequest } from "next/server";
import { POST as chatRoute } from "@/app/api/store/chat/route";
import { POST as inboxRoute } from "@/app/api/store/inbox/route";
import { readInbox } from "@/lib/inbox";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
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

async function clearMode(): Promise<void> {
  mode = null;
  if (filled.size) await real([["DEL", ...filled]]);
  filled.clear();
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "inboxroutes@example.com";
  const HANDLE = "inboxroutes";
  await claimHandle(OWNER, HANDLE, "Inbox Routes", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_InboxRte01", subscriptionId: "sub_InboxRte01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setInboxSetting(OWNER, { chat: true, saved: [] });
  const store = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);

  let ip = 10;
  const start = async () => {
    ip += 1;
    const response = await chatRoute(new NextRequest("https://marktmorgen.com/api/store/chat", {
      method: "POST",
      headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", "x-forwarded-for": `10.1.0.${ip}` },
      body: JSON.stringify({ action: "start", handle: HANDLE, email: `lee${ip}@example.org`, name: "Lee", text: "Is the course still open this month?" }),
    }));
    return [response.status, ((await response.json()) as { error?: string }).error ?? "ok"] as const;
  };
  const reply = async (id: string) => {
    const response = await inboxRoute(new NextRequest("https://marktmorgen.com/api/store/inbox", {
      method: "POST",
      headers: { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ action: "reply", id, text: "Yes, it is open until the end of the month." }),
    }));
    return [response.status, ((await response.json()) as { error?: string }).error ?? "ok"] as const;
  };

  part("The store chat route, a visitor's first message (inbox-new)");
  is("control: with room it is kept", await start(), [200, "ok"]);
  mode = { scope: "inbox-new", how: "unknown" };
  is("an unreadable count answers 503 'error', never 429", await start(), [503, "error"]);
  mode = { scope: "inbox-new", how: "full" };
  is("past the day's new conversations it answers 429 'limited'", await start(), [429, "limited"]);
  await clearMode();

  part("The studio inbox route, the team's answer (inbox-reply)");
  const conversation = (await readInbox(store.statsId))[0]?.id ?? "";
  is("(setup) a conversation is kept", conversation.length > 0, true);
  mode = { scope: "inbox-reply", how: "unknown" };
  is("an unreadable count answers 503 'error', never 429", await reply(conversation), [503, "error"]);
  mode = { scope: "inbox-reply", how: "full" };
  is("past the day's answers it answers 429 'limited'", await reply(conversation), [429, "limited"]);
  await clearMode();
  is("control: with room the answer is kept", (await reply(conversation))[0], 200);

  part("Telling the team of a new message (tellTeam, inbox-tell)");
  let before = sent;
  is("control: a new conversation is kept", await start(), [200, "ok"]);
  is("control: and the team is told by one email", sent - before, 1);
  mode = { scope: "inbox-tell", how: "full" };
  before = sent;
  is("the half-hour notice window full: the visitor's message is still kept", await start(), [200, "ok"]);
  is("and no notice is sent past the window's one", sent - before, 0);
  mode = { scope: "inbox-tell", how: "unknown" };
  before = sent;
  is("the notice's count unreadable: the visitor's message is still kept", await start(), [200, "ok"]);
  is("and no notice is sent on a count that cannot be read", sent - before, 0);
  await clearMode();

  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
