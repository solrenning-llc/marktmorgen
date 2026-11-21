/**
 * No screen says "nothing was counted" after a try that counted (VR; CX-123
 * rules 27 and 30; Revisor 1's LIGHT of 01h40 on the voice summary).
 * lib/ai.ts `counted` takes the month's job before the model is asked and
 * keeps a started try counted, because the provider may bill it: "failed"
 * always comes after the job was taken.
 *
 *   - The inbox's suggested answer, through the real code with the model
 *     answering an error: "failed", the month's job counter one higher, and
 *     the inbox's words for "failed" say the try counted, never that
 *     nothing was.
 *   - The voice summary's "server_error" is also what the page shows when
 *     the request is cut at its time limit (app/api/store/voice/route.ts,
 *     maxDuration) or the answer is not JSON, which can be after the model
 *     was asked: its words say the try may have counted, never that nothing
 *     was.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readInbox, startChat, suggestReply } from "@/lib/inbox";
import { claimHandle, ensureStatsId, setInboxSetting, setSubscription, storeForEmail } from "@/lib/store";
import { aiMonthKey } from "@/lib/ai";
import { maxDuration } from "@/app/api/store/voice/route";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_counted_only_a_stand_in";
process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;

let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.anthropic.com") {
    modelCalls++;
    return json({ type: "error", error: { type: "overloaded_error" } }, 529);
  }
  if (url.hostname === "api.resend.com") return json({ id: "email_1" });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The text of one entry of a component's words, read from its source as the page draws it. */
function said(file: string, key: string): string {
  const source = readFileSync(join(process.cwd(), file), "utf8");
  const found = new RegExp(`\\n\\s*${key}: "([^"]*)"`).exec(source);
  if (!found) throw new Error(`${file} has no ${key} words`);
  return found[1];
}

const OWNER = "counted@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "countedshop", "Counted Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Counted0001", subscriptionId: "sub_Counted0001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setInboxSetting(OWNER, { chat: true, saved: [] });
  const store = (await storeForEmail(OWNER))!;
  const started = await startChat({ store, email: "visitor@example.com", name: "Vi", text: "Does the course have a certificate?", ip: "10.0.0.7" });
  is("a visitor's conversation is in the inbox", started.ok, true);
  const id = (await readInbox(store.statsId!))[0]?.id ?? "";

  const now = Date.now();
  const key = aiMonthKey(store, new Date(now));
  const jobs = async () => Number((await redis.pipeline([["GET", key ?? ""]]))[0] ?? 0);
  const before = await jobs();
  const suggestion = await suggestReply(store, id, now);
  is("the model answering an error: failed, after the model was asked, and the month's job still counted", [suggestion.ok ? "ok" : suggestion.reason, modelCalls > 0, (await jobs()) - before], ["failed", true, 1]);

  const inboxFailed = said("components/inbox-studio.tsx", "failed");
  is("so the inbox's failed words never say nothing was counted, and say the try counted", [/nothing was counted/i.test(inboxFailed), /counted as one of this month's writing jobs/i.test(inboxFailed)], [false, true]);

  const voiceServer = said("components/customer-voice.tsx", "server_error");
  is("the voice route can be cut at its time limit after the model was asked", typeof maxDuration === "number" && maxDuration > 0, true);
  is("so the voice summary's server_error words never say nothing was counted, and say the try may have counted", [/nothing was counted/i.test(voiceServer), /may have counted as one of this month's AI jobs/i.test(voiceServer)], [false, true]);
  done();
}

void main();
