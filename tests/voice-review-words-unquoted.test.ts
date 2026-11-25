/**
 * #5285 row #5087 (Claude 1's LOW on #5087 @939dcece50, comment 7074899112): every review deletion or rewrite let go
 * of the customer summary's reader (forgetReviewWords deleted nl:voice:lock:), so a summary being built at that moment
 * was refused as "changed" after its month's AI job was counted, even when it quoted none of the deleted words. The
 * creator lost that job for a review the summary did not hold.
 *
 * Checked end to end through makeVoice, with the deletion made while the model "thinks" (after the job is counted):
 *   - a deletion of words the summary does not quote leaves the reading kept, its job well spent;
 *   - a deletion of words it does quote still refuses it as "changed" (Codex L-20261120-0948), and the next reading
 *     is not left busy behind a lock;
 *   - when the lock has no room left for another mark, the deletion lets go of the reader as before, so the words
 *     never stay on a guess.
 * Synthetic store, words and model; in-memory Redis.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { OWNER, makeWorld } from "./erasure-world";
import { ROOM } from "./data-room";
import { forgetReviewWords, makeVoice } from "@/lib/customer-voice";
import { keepAnswer } from "@/lib/answers";
import { saveReview } from "@/lib/reviews";
import { countSearchMiss } from "@/lib/stats";
import { storeForEmail } from "@/lib/store";
import { aiMonthKey } from "@/lib/ai";
import { mock } from "node:test";

mock.timers.enable({ apis: ["Date"], now: Date.now() });

/** The one review the summary quotes. */
const QUOTED = "Love the guide, wish I could print it";

/** Runs while the model "thinks": the month's AI job is counted by then. */
let during: (() => Promise<void>) | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.anthropic.com") {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const ids = [...body.messages[0].content.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    if (during) {
      const run = during;
      during = null;
      await run();
    }
    return json({ content: [{ type: "text", text: JSON.stringify({ themes: [{ title: "Wants it printable", ids }] }) }] });
  }
  if (url.hostname === "api.resend.com") return json({ id: "email_1" });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  return realFetch(input as string, init);
}) as typeof fetch;

async function world(now: number): Promise<{ statsId: string }> {
  redis.clear();
  const w = await makeWorld();
  const statsId = w.store.statsId as string;
  const store = (await storeForEmail(OWNER))!;
  for (const [i, q] of ["Is there a printable version?", "Can I print the guide?", "Does it come as a PDF?"].entries()) {
    await keepAnswer(store, `q${i}`, "x", { productId: w.plain, question: q, now: now - i * 86_400_000 });
  }
  const saved = await saveReview(statsId, { productId: w.plain, email: "kai.other@example.com", reference: "cs_test_voiceunq0001", pi: "pi_voiceunq0001", rating: 4, text: QUOTED, name: "Kai" }, ROOM);
  if (saved.state !== "created") throw new Error(`no review: ${saved.state}`);
  for (const words of ["printable", "pdf", "print version", "large print"]) await countSearchMiss(statsId, [words]);
  return { statsId };
}

const kept = async (statsId: string, now: number) => {
  const [value] = await redis.pipeline([["GET", `nl:voice:${statsId}:${new Date(now).toISOString().slice(0, 7)}`]]);
  return typeof value === "string" ? value : null;
};
const jobs = async (now: number) => {
  const store = (await storeForEmail(OWNER))!;
  const key = aiMonthKey(store, new Date(now));
  if (!key) return -1;
  const [value] = await redis.pipeline([["GET", key]]);
  return Number(value ?? 0);
};

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_voice_unquoted_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_voice_unquoted_only_a_stand_in";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  const now = Date.now();

  part("A review the summary does not quote is deleted while it is built: the summary is kept");
  {
    const { statsId } = await world(now);
    let forgot: number | null = null;
    during = async () => {
      forgot = await forgetReviewWords(statsId, "Synthetic words of a review this summary never read", now);
    };
    const made = await makeVoice((await storeForEmail(OWNER))!, now);
    is("the deletion ran in the middle of the reading, with nothing kept to delete", forgot, 0);
    is("the reading is kept, not refused as changed", made.ok && made.fresh, true);
    is("and its summary is there to show", (await kept(statsId, now))?.includes(QUOTED), true);
    is("its one AI job was spent on a summary the creator has", await jobs(now), 1);
  }

  part("A review the summary quotes is deleted while it is built: still refused, and the next reading is not busy");
  {
    const { statsId } = await world(now);
    during = async () => {
      await forgetReviewWords(statsId, QUOTED, now);
    };
    const made = await makeVoice((await storeForEmail(OWNER))!, now);
    is("refused as changed (Codex L-20261120-0948)", made, { ok: false, reason: "changed" });
    is("the deleted words are never written", await kept(statsId, now), null);
    is("the reader's lock is let go with the refusal", await redis.pipeline([["EXISTS", `nl:voice:lock:${statsId}`]]), [0]);
  }

  part("The lock has no room for another mark: the deletion lets go of the reader, as before");
  {
    const { statsId } = await world(now);
    during = async () => {
      for (let i = 0; i < 12; i += 1) await forgetReviewWords(statsId, `Synthetic unread words number ${i}`, now);
    };
    const made = await makeVoice((await storeForEmail(OWNER))!, now);
    is("refused as changed, never kept on a guess", made, { ok: false, reason: "changed" });
    is("nothing written", await kept(statsId, now), null);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
