/**
 * The copy of a person's data reads their community likes and reports exactly (issue #4780, Codex U). memberTraces
 * (lib/community.ts) turned each SISMEMBER reply into a number: a missing one became NaN, a null one 0, so a like, a
 * comment like or a report the person made was left out of their copy, which said it was complete. Now every batch
 * answers one reply per command, and each SISMEMBER answers exactly 0 or 1; anything else throws UnknownReplyError,
 * so the copy fails closed. A confirmed 0 still means the like or the report is no longer there. Both readers are
 * held: the member's own trace (tracedOf) and the whole community (scanTraces, for posts from before the trace began).
 * Synthetic, in-memory Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addComment, createPost, memberTraces, report, toggleCommentLike, toggleLike } from "@/lib/community";
import { TRACED_SINCE, traceKey } from "@/lib/community-trace";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "membershipowner@example.com";
const ADA = "adakey00000000000000000000000001";
const BOB = "bobkey00000000000000000000000002";
type Batch = (string | number)[][];
const realNow = Date.now;

/** While `run` runs, a batch holding a SISMEMBER is answered by `alter` from its real replies. */
async function withMarks<T>(alter: (batch: Batch, replies: unknown[]) => unknown[], run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => {
    const replies = await real(batch);
    return batch.some(([op]) => op === "SISMEMBER") ? alter(batch, replies) : replies;
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

const SHAPES: [string, (batch: Batch, replies: unknown[]) => unknown[]][] = [
  ["a null reply", (batch, replies) => replies.map((r, i) => (batch[i][0] === "SISMEMBER" ? null : r))],
  ["a reply cut short", (_batch, replies) => replies.slice(0, -1)],
  ["a reply of another shape", (batch, replies) => replies.map((r, i) => (batch[i][0] === "SISMEMBER" ? "1" : r))],
];

/** One kind of SISMEMBER the copy reads, by its key: a like of a post, of a comment, a report of each. */
const KINDS: [string, RegExp][] = [
  ["a like of a post", /:l:[^:]+$/],
  ["a like of a comment", /:lc:[^:]+:[^:]+$/],
  ["a report of a post", /:rep:p:[^:]+$/],
  ["a report of a comment", /:rep:c:[^:]+:[^:]+$/],
];

/** A community where Ada liked Bob's post and his comment and reported both, written at `at` seconds. */
async function world(at: number): Promise<{ id: string; post: string; comment: string }> {
  redis.clear();
  await claimHandle(OWNER, "membershipshop", "Membership Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Memb00001", subscriptionId: "sub_Memb00001", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  Date.now = () => at * 1000;
  try {
    const made = await createPost(id, { space: "", author: BOB, title: "Hello", text: "A post", img: null, kind: "post", poll: null }, store);
    if (!made.ok) throw new Error("no post");
    const said = await addComment(id, made.post.id, { parent: "", author: BOB, text: "A comment" }, store);
    if (!said.ok) throw new Error("no comment");
    await toggleLike(id, made.post.id, ADA, store);
    await toggleCommentLike(id, made.post.id, said.comment.id, ADA, store);
    await report(id, { kind: "post", post: made.post.id }, ADA, store);
    await report(id, { kind: "comment", post: made.post.id, comment: said.comment.id }, ADA, store);
    return { id, post: made.post.id, comment: said.comment.id };
  } finally {
    Date.now = realNow;
  }
}

for (const [reader, at] of [["her own trace", TRACED_SINCE + 86_400], ["the whole community", TRACED_SINCE - 86_400]] as const) {
  test(`read from ${reader}: the likes and the report are in the copy`, async () => {
    const { id, post, comment } = await world(at);
    const copy = await memberTraces(id, ADA);
    assert.deepEqual(copy.likedPosts, [post]);
    assert.deepEqual(copy.likedComments, [{ post, comment }]);
    assert.deepEqual([...copy.reported].sort(), [`comment ${comment} under post ${post}`, `post ${post}`]);
  });

  // Each of the seven reads is held on its own (Claude 5 iZdj's LEVE on #5171): only one kind of SISMEMBER is
  // answered null, every other reply stays real, so a read turned back into Number(reply) alone fails here.
  for (const [kind, key] of KINDS) {
    test(`read from ${reader}: only ${kind} answered null makes the copy fail`, async () => {
      const { id } = await world(at);
      let hit = 0;
      const alter = (batch: Batch, replies: unknown[]) =>
        replies.map((r, i) => (batch[i][0] === "SISMEMBER" && key.test(String(batch[i][1])) ? (hit++, null) : r));
      await assert.rejects(withMarks(alter, () => memberTraces(id, ADA)), UnknownReplyError);
      assert.ok(hit > 0, `the copy read ${kind}`);
    });
  }

  for (const [label, alter] of SHAPES) {
    test(`read from ${reader}: ${label} makes the copy fail, never leave a like or a report out`, async () => {
      const { id } = await world(at);
      await assert.rejects(withMarks(alter, () => memberTraces(id, ADA)), UnknownReplyError);
    });
  }

  test(`read from ${reader}: a confirmed 0 still leaves the like and the report out`, async () => {
    const { id } = await world(at);
    const copy = await withMarks((batch, replies) => replies.map((r, i) => (batch[i][0] === "SISMEMBER" ? 0 : r)), () => memberTraces(id, ADA));
    assert.deepEqual([copy.likedPosts, copy.likedComments, copy.reported], [[], [], []]);
  });
}

test("the issue's case: one like in the trace, its SISMEMBER answered null", async () => {
  redis.clear();
  const id = "c".repeat(32);
  const who = "a".repeat(32);
  await redis.pipeline([["SADD", traceKey(id, who), "l:p1"]]);
  await assert.rejects(withMarks(() => [null], () => memberTraces(id, who)), UnknownReplyError);
});
