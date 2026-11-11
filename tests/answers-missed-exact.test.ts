/**
 * The questions a page could not answer, kept for the creator
 * (lib/answers.ts missedQuestions), are read in their exact shape (rule 24;
 * follow-up of the R24 inventory note on lib/customer-voice.ts): a list that
 * is not there is no questions, legitimately; a reply in any other shape, or
 * a kept row that is not one of ours, throws UnknownReplyError instead of
 * meaning "no questions", so whoever reads them can say they could not be
 * read (lib/customer-voice.ts names the list as unread).
 *
 * Synthetic data only; Redis is the in-memory stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepAnswer, missedQuestions } from "@/lib/answers";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

redis.clear();

async function storeOf(owner: string, handle: string) {
  await claimHandle(owner, handle, `${handle} store`, "");
  await ensureStatsId(owner);
  return (await storeForEmail(owner))!;
}

const fixture = (async () => {
  const store = await storeOf("owner.missed@example.com", "missedq");
  const now = Date.now();
  await keepAnswer(store, "h1", "x", { productId: "prodaaaaaa", question: "Is there a printable version?", now });
  await keepAnswer(store, "h2", "x", { productId: "prodaaaaaa", question: "Does it work in metric?", now: now - 86_400_000 });
  return store;
})();

test("questions kept in their own shape are read, the last kept first", async () => {
  const store = await fixture;
  assert.deepEqual((await missedQuestions(store)).map((m) => m.question), ["Does it work in metric?", "Is there a printable version?"]);
});

test("a store with no questions kept has none, legitimately", async () => {
  const store = await storeOf("owner.none@example.com", "noneq");
  assert.deepEqual(await missedQuestions(store), []);
});

const ROW = { p: "prodaaaaaa", q: "Is there a printable version?", at: 1_790_000_000 };
for (const [label, reply] of [
  ["no reply at all", []],
  ["a null where the list should be", [null]],
  ["a word where the list should be", ["OK"]],
  ["a number where the list should be", [3]],
  ["a row that is not text", [[5]]],
  ["a row that is not JSON", [["{"]]],
  ["a row that is a list, not a question", [["[]"]]],
  ["a row without its product", [[JSON.stringify({ q: ROW.q, at: ROW.at })]]],
  ["a row without its question", [[JSON.stringify({ p: ROW.p, at: ROW.at })]]],
  ["a row without its time", [[JSON.stringify({ p: ROW.p, q: ROW.q })]]],
] as const) {
  test(`questions answered with ${label} are unknown, never "none"`, async () => {
    const store = await fixture;
    const original = redis.pipeline;
    redis.pipeline = (async () => [...reply]) as typeof redis.pipeline;
    try {
      await assert.rejects(() => missedQuestions(store), UnknownReplyError);
    } finally {
      redis.pipeline = original;
    }
  });
}

test("a whole row in our own shape, read through the same check, is kept", async () => {
  const store = await fixture;
  const original = redis.pipeline;
  redis.pipeline = (async () => [[JSON.stringify(ROW)]]) as typeof redis.pipeline;
  try {
    assert.deepEqual(await missedQuestions(store), [{ productId: ROW.p, question: ROW.q, at: ROW.at }]);
  } finally {
    redis.pipeline = original;
  }
});
