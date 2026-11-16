/**
 * The voice summary counts no AI job it has no time to finish (Revisor 1's
 * note on #2621). The route ends at maxDuration (60 s); the month's job is
 * taken before the model is asked and stays taken (lib/ai.ts counted), so
 * a reading that ran long would be cut by the platform after counting.
 * The route runs makeVoice inside the request's cutoff (lib/fetch-timeout.ts
 * withCutoff), and makeVoice reads the time left (timeLeft):
 *
 *   - with less than VOICE_MODEL_MIN_MS left after the reading, beyond the
 *     margin kept to save the summary, it answers "late" before counting:
 *     no model call, the month's jobs unchanged, nothing kept;
 *   - with room, the model is asked as before and the summary kept, the
 *     model's request given at most the time left less that margin;
 *   - the screen's words for "late" say that no job was used.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { ROOM } from "./data-room";
import { MIN_TEXTS, VOICE_DEADLINE_MARGIN_MS, VOICE_MODEL_MIN_MS, gatherVoice, makeVoice } from "@/lib/customer-voice";
import { keepAnswer } from "@/lib/answers";
import { saveReview } from "@/lib/reviews";
import { countSearchMiss } from "@/lib/stats";
import { storeForEmail } from "@/lib/store";
import { aiMonthKey } from "@/lib/ai";
import { withCutoff } from "@/lib/fetch-timeout";

let modelCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.anthropic.com") {
    modelCalls++;
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const ids = [...body.messages[0].content.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    return json({ content: [{ type: "text", text: JSON.stringify({ themes: [{ title: "Wants it printable", ids }] }) }] });
  }
  if (url.hostname === "api.resend.com") return json({ id: "email_1" });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  return realFetch(input as string, init);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_voice_deadline_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_voice_deadline_only_a_stand_in";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";

  const w = await makeWorld();
  const statsId = w.store.statsId as string;
  const now = Date.now();
  await seedPerson(w, "tess.deadline@example.com", null);
  let store = (await storeForEmail(OWNER))!;
  for (const [i, q] of ["Is there a printable version?", "Can I print the guide?", "Does it come as a PDF?"].entries()) {
    await keepAnswer(store, `q${i}`, "x", { productId: w.plain, question: q, now: now - i * 86_400_000 });
  }
  const saved = await saveReview(statsId, { productId: w.plain, email: "kai.deadline@example.com", reference: "cs_test_voicedeadline01", pi: "pi_voicedeadline01", rating: 4, text: "Love the guide, wish I could print it", name: "Kai" }, ROOM);
  if (saved.state !== "created") throw new Error(`no review: ${saved.state}`);
  for (const words of ["printable", "pdf", "print version", "large print"]) await countSearchMiss(statsId, [words]);
  store = (await storeForEmail(OWNER))!;
  is(`enough to read (at least ${MIN_TEXTS})`, (await gatherVoice(store, now)).items.length >= MIN_TEXTS, true);

  const key = aiMonthKey(store, new Date(now));
  const jobs = async () => Number((await redis.pipeline([["GET", key ?? ""]]))[0] ?? 0);
  const kept = async () => (await redis.pipeline([["EXISTS", `nl:voice:${statsId}:${new Date(now).toISOString().slice(0, 7)}`]]))[0];

  const late = await withCutoff(Date.now() + VOICE_DEADLINE_MARGIN_MS + VOICE_MODEL_MIN_MS - 1_000, () => makeVoice(store, now));
  is("too little time left after the reading: late, before counting; no model call, no job taken, nothing kept", [late.ok ? "ok" : late.reason, modelCalls, await jobs(), await kept()], ["late", 0, 0, 0]);
  const past = await withCutoff(Date.now() - 1, () => makeVoice(store, now));
  is("a deadline already passed: late too, nothing counted", [past.ok ? "ok" : past.reason, modelCalls, await jobs()], ["late", 0, 0]);

  const made = await withCutoff(Date.now() + VOICE_DEADLINE_MARGIN_MS + VOICE_MODEL_MIN_MS + 2_000, () => makeVoice(store, now));
  is("with room left: the model is asked, one job taken, the summary kept", [made.ok, modelCalls, await jobs(), await kept()], [true, 1, 1, 1]);

  const source = readFileSync(join(process.cwd(), "components/customer-voice.tsx"), "utf8");
  const words = /\n\s*late: "([^"]*)"/.exec(source)?.[1] ?? "";
  is("the screen's words for late say no AI job was used", [words !== "", /no AI job was used/i.test(words), /may have counted|counted as one/i.test(words)], [true, true, false]);
  done();
}

void main();
