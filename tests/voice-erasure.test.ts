/**
 * What customers are saying (lib/customer-voice.ts) and a person's erasure
 * (lib/person-erasure.ts), rule 28: an erased person's data never comes back.
 *
 * The month's summary keeps customers' own words as its examples for about
 * two months (nl:voice:<statsId>:<month>). Checked, through the real erasure
 * in the in-memory Redis:
 *
 *   - the erasure takes every kept summary of the store with it, so a
 *     person's review words are not shown again from it;
 *   - the summary read again after it leaves them out, because their review
 *     went with them at its source;
 *   - a summary being read while the person is deleted is not kept: it was
 *     gathered before their words went, and the check and the write are one
 *     step on the Redis side, so the erasure cannot fall between them;
 *   - what members wrote when leaving, which comes from the creator's Stripe
 *     account with nobody named beside it and so cannot be checked against
 *     the deleted, is counted but never kept as an example, not even in a
 *     summary written before this rule;
 *   - at the studio's door the reviews are kept (FTC rule), the summary read
 *     again quotes them, and the lines each door shows say exactly that;
 *   - a write that fails after the month's AI job was counted answers
 *     "changed", whose words say it counted, and the "failed" words never
 *     say nothing was counted, since a model that answered with an error
 *     leaves the job counted.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { ROOM } from "./data-room";
import { LOCK_SECONDS, MIN_TEXTS, gatherVoice, makeVoice, readVoice } from "@/lib/customer-voice";
import { erasePerson } from "@/lib/person-erasure";
import { keepAnswer } from "@/lib/answers";
import { saveReview } from "@/lib/reviews";
import { countSearchMiss } from "@/lib/stats";
import { storeForEmail } from "@/lib/store";
import { linesOf } from "@/lib/person-data";
import { aiMonthKey } from "@/lib/ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PERSON = "tess.voice@example.com";
/** The person's review words, as lib/reviews.ts keeps them (tests/erasure-world.ts, seedPerson). */
const THEIR_WORDS = "Loved it";

/** What the model is asked to sort; `during` runs while it "thinks", to put an erasure in the middle of a reading. */
let during: (() => Promise<void>) | null = null;
/** The model answering with an error status, as a provider outage does. */
let modelDown = false;
/** Whether the summary's one-step write throws, as a database that does not answer does. */
let keepThrows = false;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (keepThrows && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:voice-keep:v1\n"))) throw new Error("the database did not answer");
  return pipeline(commands);
}) as typeof redis.pipeline;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.anthropic.com") {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const text = body.messages[0].content;
    // Every numbered text in one theme: whatever was handed, it is kept as an example when it can be.
    const ids = [...text.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    const loved = [...text.matchAll(/^\[(\d+)\].*\b(?:Loved|Love)\b/gm)].map((m) => Number(m[1]));
    const rest = ids.filter((id) => !loved.includes(id));
    if (modelDown) return json({}, 500);
    if (during) {
      const run = during;
      during = null;
      await run();
    }
    return json({ content: [{ type: "text", text: JSON.stringify({ themes: [{ title: "Loved the guide", ids: loved }, { title: "Wants it printable", ids: rest }] }) }] });
  }
  if (url.hostname === "api.resend.com") return json({ id: "email_1" });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  return realFetch(input as string, init);
}) as typeof fetch;

/** Every summary kept for the store, by key. */
async function summaries(statsId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const [reply] = await redis.pipeline([["SCAN", "0", "MATCH", `nl:voice:${statsId}:*`, "COUNT", 1000]]);
  for (const key of (reply as [string, string[]])[1]) {
    const [value] = await redis.pipeline([["GET", key]]);
    if (typeof value === "string") out.set(key, value);
  }
  return out;
}

/** Enough other customers' words for a summary to be worth reading, with one more review of loving it. */
async function others(statsId: string, productId: string, now: number): Promise<void> {
  const store = (await storeForEmail(OWNER))!;
  for (const [i, q] of ["Is there a printable version?", "Can I print the guide?", "Does it come as a PDF?"].entries()) {
    await keepAnswer(store, `q${i}`, "x", { productId, question: q, now: now - i * 86_400_000 });
  }
  const saved = await saveReview(statsId, { productId, email: "kai.other@example.com", reference: "cs_test_voiceother0001", pi: "pi_voiceother0001", rating: 4, text: "Love the guide, wish I could print it", name: "Kai" }, ROOM);
  if (saved.state !== "created") throw new Error(`no review: ${saved.state}`);
  for (const words of ["printable", "pdf", "print version", "large print"]) await countSearchMiss(statsId, [words]);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_voice_erasure_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_voice_erasure_only_a_stand_in";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";

  const w = await makeWorld();
  const statsId = w.store.statsId as string;
  const now = Date.now();
  await seedPerson(w, PERSON, null);
  await others(statsId, w.plain, now);
  let store = (await storeForEmail(OWNER))!;
  const { items: gathered } = await gatherVoice(store, now);
  is(`enough to read (at least ${MIN_TEXTS}), with the person's review among them`, [gathered.length >= MIN_TEXTS, gathered.some((g) => g.text === THEIR_WORDS)], [true, true]);

  part("The erasure takes the kept summary with it");
  const made = await makeVoice(store, now);
  if (!made.ok) throw new Error(`no summary: ${made.reason}`);
  is("before: the summary keeps the person's words as an example", [...(await summaries(statsId)).values()].some((v) => v.includes(`"${THEIR_WORDS}"`)), true);
  // Last month's summary too: it is shown while this month has none (readVoice).
  const last = new Date(now);
  last.setUTCDate(1);
  last.setUTCMonth(last.getUTCMonth() - 1);
  const lastKey = `nl:voice:${statsId}:${last.toISOString().slice(0, 7)}`;
  await redis.pipeline([["SET", lastKey, JSON.stringify({ ...made.summary, month: last.toISOString().slice(0, 7) }), "EX", 70 * 86_400]]);
  const erased = await erasePerson(store, PERSON, { kind: "person" });
  is("the erasure finished", erased.ok, true);
  const left = await summaries(statsId);
  is("after: no summary of the store keeps their words, this month's or last month's", [...left.values()].some((v) => v.includes(THEIR_WORDS)), false);
  is("and the studio reads none until it is read again", await readVoice(store, now), null);
  is("the erasure says it reached the summary", erased.ok && erased.parts.some((p) => p.module === "lib/customer-voice.ts"), true);

  part("Read again, it leaves them out");
  store = (await storeForEmail(OWNER))!;
  await countSearchMiss(statsId, ["spiral bound"]);
  const again = await makeVoice(store, now);
  if (!again.ok) throw new Error(`no summary again: ${again.reason}`);
  is("their review went at its source, so it is not read again", JSON.stringify(again.summary).includes(THEIR_WORDS), false);
  is("the other customer's review is still read, and the questions still quoted", [again.summary.read.review, again.summary.themes[0]?.examples.length], [1, 3]);

  part("A summary read while the person is deleted is not kept");
  redis.clear();
  const w2 = await makeWorld();
  const statsId2 = w2.store.statsId as string;
  await seedPerson(w2, PERSON, null);
  await others(statsId2, w2.plain, now);
  const store2 = (await storeForEmail(OWNER))!;
  let racing: Awaited<ReturnType<typeof erasePerson>> | null = null;
  during = async () => {
    racing = await erasePerson((await storeForEmail(OWNER))!, PERSON, { kind: "person" });
  };
  const raced = await makeVoice(store2, now);
  is("the erasure ran in the middle of the reading", (racing as { ok: boolean } | null)?.ok, true);
  is("the reading gathered before their words went is not kept", [...(await summaries(statsId2)).values()].some((v) => v.includes(THEIR_WORDS)), false);
  is("and is not handed back to be shown either", raced.ok ? JSON.stringify(raced.summary).includes(THEIR_WORDS) : false, false);
  is("it says the store changed while it was read", raced, { ok: false, reason: "changed" });
  const after = await makeVoice((await storeForEmail(OWNER))!, now);
  is("read again, it is made, without them", after.ok && !JSON.stringify(after.summary).includes(THEIR_WORDS), true);

  part("What members wrote when leaving is never kept as an example");
  const month = new Date(now).toISOString().slice(0, 7);
  const old = {
    at: Math.floor(now / 1000),
    month,
    read: { cancel: 2, review: 1 },
    themes: [{ title: "Price feels high", count: 3, sources: { cancel: 2, review: 1 }, examples: [{ source: "cancel", text: "Too dear for me, I'm Pat", n: 1 }, { source: "review", text: "Good but costly", n: 1 }] }],
    reviewThemes: [{ title: "Price feels high", count: 3, sources: { cancel: 2, review: 1 }, examples: [{ source: "review", text: "Good but costly", n: 1 }] }],
    other: 0,
  };
  await redis.pipeline([["SET", `nl:voice:${statsId2}:${month}`, JSON.stringify(old), "EX", 70 * 86_400]]);
  const shown = await readVoice((await storeForEmail(OWNER))!, now);
  is("a summary kept before this rule is read without them, its counts unchanged", [shown?.themes[0].examples.map((e) => e.text), shown?.themes[0].count], [["Good but costly"], 3]);

  part("The studio's door keeps the reviews, and says the summary still quotes them (FTC rule, lib/reviews.ts)");
  redis.clear();
  const w3 = await makeWorld();
  const statsId3 = w3.store.statsId as string;
  await seedPerson(w3, PERSON, null);
  await others(statsId3, w3.plain, now);
  await makeVoice((await storeForEmail(OWNER))!, now);
  const byTeam = await erasePerson((await storeForEmail(OWNER))!, PERSON, { kind: "team", who: OWNER, role: "owner" });
  is("the team's erasure finished and took the summary", [byTeam.ok, (await summaries(statsId3)).size], [true, 0]);
  const reread = await makeVoice((await storeForEmail(OWNER))!, now);
  is("read again, it quotes the review they wrote, which is kept", reread.ok && JSON.stringify(reread.summary).includes(`"${THEIR_WORDS}"`), true);
  const voiceLines = (door: "team" | "person") => linesOf("erased", door).filter((l) => l.startsWith("The month's summary of what your customers said"));
  is("the person's door says the summary read again leaves them out", voiceLines("person").map((l) => [l.includes("read again, it leaves them out"), l.includes("still quotes")]), [[true, false]]);
  is("the team's door says it still quotes the reviews they wrote, which are kept", voiceLines("team").map((l) => [l.includes("read again, it leaves them out"), l.includes("still quotes the reviews they wrote, which are kept")]), [[false, true]]);

  part("What the creator is told is true about the month's AI jobs");
  redis.clear();
  const w4 = await makeWorld();
  await seedPerson(w4, PERSON, null);
  await others(w4.store.statsId as string, w4.plain, now);
  const jobs = async () => String((await redis.pipeline([["GET", aiMonthKey((await storeForEmail(OWNER))!, new Date(now))!]]))[0]);
  keepThrows = true;
  const lost = await makeVoice((await storeForEmail(OWNER))!, now).catch((error: unknown) => ({ threw: String(error) }));
  keepThrows = false;
  is("the write failing after the job was counted says the store changed, never a server error that claims nothing was counted", [lost, await jobs()], [{ ok: false, reason: "changed" }, "1"]);
  modelDown = true;
  const failed = await makeVoice((await storeForEmail(OWNER))!, now);
  modelDown = false;
  is("a model that answered with an error: failed, and the try still counted (lib/ai.ts, counted)", [failed, await jobs()], [{ ok: false, reason: "failed" }, "2"]);
  const words = readFileSync(join(process.cwd(), "components/customer-voice.tsx"), "utf8");
  const said = (key: string) => (words.match(new RegExp(`\\n  ${key}: "([^"]*)"`)) ?? [])[1] ?? "";
  is("so the failed message never says nothing was counted, and the changed one says it was", [/nothing was counted/i.test(said("failed")), /counted as one of this month's AI jobs/.test(said("changed"))], [false, true]);
  is("the cancellation words' sentence says nothing kept with them says who wrote them", words.includes("nothing kept with it says who wrote it"), true);

  part("The request ends before its lock does, so a second reading cannot start and be charged while the first still runs");
  const route = (await import("@/app/api/store/voice/route")) as { maxDuration?: number };
  is("the voice route declares a time limit below the reading's lock", typeof route.maxDuration === "number" && route.maxDuration > 0 && route.maxDuration < LOCK_SECONDS, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
