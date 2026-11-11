/**
 * What customers are saying, with the questions the Store assistant could
 * not answer as a fifth list (95 [D2-DEMAND-RADAR], unit 1: only what
 * lib/customer-voice.ts did not read yet).
 *
 * What fails here:
 *   - the assistant's unanswered questions left out of the texts, or kept
 *     with an address, a phone or a link in them, or with who asked;
 *   - a list read that failed, came back in another shape or with a row this
 *     code never wrote, taken as a list with nothing in it (rule 24): it is
 *     named as unread instead;
 *   - the model told those texts are something else, or the screen unable
 *     to name the list.
 *
 * Synthetic data only; Redis is the in-memory stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherVoice, voicePrompt } from "@/lib/customer-voice";
import { assistantMissedExact } from "@/lib/store-assistant";
import { claimHandle, ensureStatsId } from "@/lib/store";
import * as voiceScreen from "@/components/customer-voice";
import { store as redis } from "./redis-stub";

redis.clear();
const now = Date.now();
const S = (ms: number) => Math.floor(ms / 1000);

async function assistantStore(owner: string, handle: string, questions: [string, number][]) {
  assert.equal((await claimHandle(owner, handle, "Shop", "")).ok, true);
  const store = (await ensureStatsId(owner))!;
  for (const [q, at] of questions) await redis.pipeline([["LPUSH", `nl:assist:missed:${store.statsId}`, JSON.stringify({ q, at })]]);
  return store;
}

async function withReply<T>(key: string, answer: (replies: unknown[], commands: unknown[][]) => unknown[], body: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: unknown[][]) => {
    const replies = (await original.call(redis, commands as never)) as unknown[];
    return commands.some((c) => c[1] === key) ? answer(replies, commands) : replies;
  }) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = original;
  }
}

test("the assistant's unanswered questions of the last 90 days are a list of their own, cleaned and unnamed", async () => {
  const store = await assistantStore("voice.assist@example.com", "voice-assist", [
    ["Old question from last year", S(now - 120 * 86_400_000)],
    ["Do you ship the printed planner to Canada? write me at ana@example.com", S(now - 2 * 86_400_000)],
    ["Is there a version for teachers?", S(now - 86_400_000)],
  ]);
  const { items, unread } = await gatherVoice(store, now);
  assert.deepEqual(unread, []);
  const asked = items.filter((i) => i.source === "assistant");
  assert.deepEqual(asked.map((i) => i.text), ["Is there a version for teachers?", "Do you ship the printed planner to Canada? write me at [email]"]);
  assert.ok(asked.every((i) => i.n === 1 && !("product" in i && i.product)), "no product and no count beyond the one question");
  assert.ok(!JSON.stringify(items).includes("ana@example.com"), "no address reaches the texts");
  assert.match(voicePrompt(asked), /\(a buyer's question the Store assistant could not answer\)/);
});

test("an assistant list that cannot be read whole is named, never taken for none", async () => {
  const store = await assistantStore("voice.unread@example.com", "voice-unread", [["Is there a version for teachers?", S(now)]]);
  const key = `nl:assist:missed:${store.statsId}`;
  const cases: [string, (replies: unknown[], commands: unknown[][]) => unknown[]][] = [
    ["the read failed", () => { throw new Error("Redis did not answer (synthetic)"); }],
    ["no reply", () => []],
    ["a null where the list should be", (r, c) => c.map((cmd, i) => (cmd[1] === key ? null : r[i]))],
    ["a word where the list should be", (r, c) => c.map((cmd, i) => (cmd[1] === key ? "OK" : r[i]))],
    ["a row that is not JSON beside a whole one", (r, c) => c.map((cmd, i) => (cmd[1] === key ? [...(r[i] as string[]), "not json {"] : r[i]))],
    ["a row with no question", (r, c) => c.map((cmd, i) => (cmd[1] === key ? [...(r[i] as string[]), JSON.stringify({ at: S(now) })] : r[i]))],
    ["a row with no time", (r, c) => c.map((cmd, i) => (cmd[1] === key ? [...(r[i] as string[]), JSON.stringify({ q: "Hi?" })] : r[i]))],
  ];
  for (const [what, answer] of cases) {
    const result = await withReply(key, answer, () => gatherVoice(store, now));
    assert.deepEqual(result.unread, ["assistant"], what);
    await assert.rejects(() => withReply(key, answer, () => assistantMissedExact(store, 50)), what);
  }
  assert.deepEqual((await gatherVoice(store, now)).unread, [], "read whole again: nothing named");
});

test("a store with no assistant questions has an exact empty list", async () => {
  const store = await assistantStore("voice.none@example.com", "voice-none", []);
  assert.deepEqual(await assistantMissedExact(store, 50), []);
  assert.deepEqual((await gatherVoice(store, now)).unread, []);
});

test("the screen names the list", () => {
  assert.equal(voiceScreen.unreadWords(["assistant"]), "Questions the assistant could not answer");
  assert.equal(voiceScreen.unreadWords(["review", "assistant"]), "Reviews and questions the assistant could not answer");
});
