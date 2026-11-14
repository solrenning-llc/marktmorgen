/**
 * Claude 1's review of #3731 (cloud C4), on "What customers are saying" (app/api/store/voice/route.ts):
 *   - MEDIUM: a store whose studio requests were used up was told "This month's AI jobs are used up", which is false:
 *     no AI job was used, and a store's place in the month's pool does not follow its billing month. It is now told
 *     what is used up, in the studio's own words (studio_used, with its message), and never about AI jobs.
 *   - LOW: the route took VOICE_EXTRA_STUDIO_UNITS of the studio requests on every click, before makeVoice saw that
 *     this month's summary was already kept or that another reading held the lock. They are now taken only when the
 *     lists are about to be read (MR: paid for before they are read, never for what is not read).
 * Called as the studio calls it, with a real session, on the in-memory store; the model is a stand-in.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/voice/route";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { VOICE_EXTRA_STUDIO_UNITS } from "@/lib/customer-voice";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "voiceunits@example.com";
/** The voice reading's own takes of studio requests: INCRBY of VOICE_EXTRA_STUDIO_UNITS on the studio figure. */
let extraTakes = 0;
let usedUp = false;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const take = commands.find((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:allow:studio:") && Number(c[2]) === VOICE_EXTRA_STUDIO_UNITS);
  if (take) extraTakes++;
  const replies = await pipeline(commands);
  // Used up: the real increment lands (so its give-back lands on it too), and its count reads past every limit.
  if (take && usedUp) return replies.map((reply, i) => (commands[i] === take ? 1_000_000 : reply));
  return replies;
}) as typeof redis.pipeline;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.anthropic.com") return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ themes: [] }) }] }));
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  await claimHandle(OWNER, "voiceunits", "Voice Units", "Recipes.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_VoiceUnits01", subscriptionId: "sub_VoiceUnits01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async () => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/voice", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: "{}" }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; message?: string; fresh?: boolean } };
  };
  const month = new Date().toISOString().slice(0, 7);

  part("MEDIUM: studio requests used up are said as such, never as AI jobs");
  usedUp = true;
  extraTakes = 0;
  const used = await call();
  usedUp = false;
  is("refused as the studio's requests, with their own words", [used.status, used.body.error, typeof used.body.message === "string" && used.body.message.length > 0], [429, "studio_used", true]);
  is("never told that AI jobs are used up", /AI job/i.test(used.body.message ?? ""), false);

  part("LOW: nothing is taken when this month's summary is already kept");
  part("LOW: nothing is taken while another reading holds the lock");
  await pipeline([["SET", `nl:voice:lock:${store.statsId}`, "another-reading", "EX", 120]]);
  extraTakes = 0;
  const busy = await call();
  is("refused as busy", busy.body.error, "busy");
  is("and none of the extra studio requests are taken for it", extraTakes, 0);
  await pipeline([["DEL", `nl:voice:lock:${store.statsId}`]]);

  part("LOW: nothing is taken when this month's summary is already kept");
  await pipeline([["SET", `nl:voice:${store.statsId}:${month}`, JSON.stringify({ month, themes: [] })]]);
  extraTakes = 0;
  const again = await call();
  is("this month's summary comes back as kept", [again.body.ok, again.body.fresh], [true, false]);
  is("and none of the extra studio requests are taken for it", extraTakes, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
