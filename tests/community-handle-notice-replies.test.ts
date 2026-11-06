/**
 * CX-123 rule 24 in a community's handles and notices: a Redis reply is read
 * only in its exact shape. A reply that is missing, cut short or of another
 * shape is not "nobody holds this handle", "no notices" or "room for every
 * list": what depends on it refuses.
 *
 *   forgetHandle  (lib/community-mentions.ts), the erasure of the handle
 *                 others used to name a member: an unknown owner reply must
 *                 not be taken as "not theirs" (the handle, made from their
 *                 name, would stay pointing at them), and an unknown HDEL
 *                 reply must not be counted as nothing deleted.
 *   allNoticesOf  (lib/community-notify.ts), the person's copy of their data
 *                 (lib/person-copy.ts): an unknown list reply must not become
 *                 a copy with their notices silently left out.
 *   tell          (lib/community-notify.ts): an unknown list size must not
 *                 file a notice whose room in the store's data room was never
 *                 taken.
 *
 * Runs the real code against the in-memory Redis (tests/redis-stub.ts),
 * synthetic ids only, no provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimHandle, forgetHandle } from "@/lib/community-mentions";
import { allNoticesOf, tell } from "@/lib/community-notify";
import { store } from "./redis-stub";

const COMMUNITY = "handle-notice-replies";
const MEMBER = "c3c3c3c3c3c3";
const OTHER = "d4d4d4d4d4d4";
const HANDLES = `nl:cm:${COMMUNITY}:h`;
const LIST = `nl:cm:${COMMUNITY}:nt:${MEMBER}`;
const room = { sid: "handle-notice-replies-1", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_synthetic", trialEnds: 0, planEndedAt: "" };
const TAKE_DATA = "-- marktmorgen:store-data:v1";

type Batch = (string | number)[][];

async function withPipeline(answer: (batch: Batch, original: (batch: Batch) => Promise<unknown[]>) => Promise<unknown[]>, run: () => Promise<void>): Promise<void> {
  const original: typeof store.pipeline = store.pipeline.bind(store);
  store.pipeline = async (batch) => answer(batch, original) as Promise<unknown[]>;
  try {
    await run();
  } finally {
    store.pipeline = original;
  }
}

const unknownReplies: unknown[] = [null, undefined, "OK", {}, [], [1, 2]];

test("forgetHandle: the member's own handle is let go and counted; absent or another's is left alone", async () => {
  store.clear();
  assert.equal(await claimHandle(COMMUNITY, MEMBER, "Maria Synthetic", ""), "maria-synthetic");
  assert.equal(await forgetHandle(COMMUNITY, "maria-synthetic", MEMBER), 1);
  assert.equal(await store.pipeline([["HGET", HANDLES, "maria-synthetic"]]).then(([v]) => v), null);
  assert.equal(await forgetHandle(COMMUNITY, "maria-synthetic", MEMBER), 0);
  await claimHandle(COMMUNITY, OTHER, "Maria Synthetic", "");
  assert.equal(await forgetHandle(COMMUNITY, "maria-synthetic", MEMBER), 0);
  assert.equal(await store.pipeline([["HGET", HANDLES, "maria-synthetic"]]).then(([v]) => v), OTHER);
});

test("forgetHandle: an owner reply in an unknown shape refuses and deletes nothing", async () => {
  const shapes: unknown[] = [...unknownReplies, [undefined], [1], [true], [["x"]], [{}]];
  for (const reply of shapes) {
    store.clear();
    await claimHandle(COMMUNITY, MEMBER, "Maria Synthetic", "");
    const sent: Batch = [];
    await withPipeline(async (batch, original) => {
      sent.push(...batch);
      return batch[0][0] === "HGET" ? (reply as unknown[]) : original(batch);
    }, async () => {
      await assert.rejects(forgetHandle(COMMUNITY, "maria-synthetic", MEMBER), `owner reply ${JSON.stringify(reply)}`);
    });
    assert.deepEqual(sent.map((c) => c[0]), ["HGET"], `owner reply ${JSON.stringify(reply)}`);
    assert.equal(await store.pipeline([["HGET", HANDLES, "maria-synthetic"]]).then(([v]) => v), MEMBER);
  }
});

test("forgetHandle: a deletion reply in an unknown shape is said as not done, never as zero", async () => {
  const shapes: unknown[] = [...unknownReplies, [undefined], [null], ["1"], [-1], [2], [1.5], [Number.NaN]];
  for (const reply of shapes) {
    store.clear();
    await claimHandle(COMMUNITY, MEMBER, "Maria Synthetic", "");
    await withPipeline(async (batch, original) => (batch[0][0] === "HDEL" ? (reply as unknown[]) : original(batch)), async () => {
      await assert.rejects(forgetHandle(COMMUNITY, "maria-synthetic", MEMBER), `HDEL reply ${JSON.stringify(reply)}`);
    });
  }
  store.clear();
  await claimHandle(COMMUNITY, MEMBER, "Maria Synthetic", "");
  await withPipeline(async (batch, original) => (batch[0][0] === "HDEL" ? [0] : original(batch)), async () => {
    assert.equal(await forgetHandle(COMMUNITY, "maria-synthetic", MEMBER), 0);
  });
});

test("allNoticesOf: the copy holds the member's notices; a confirmed empty list is none", async () => {
  store.clear();
  assert.deepEqual(await allNoticesOf(COMMUNITY, MEMBER), []);
  await tell(COMMUNITY, [MEMBER], { kind: "reply", post: "p1", comment: "", by: OTHER, words: "synthetic words" }, room);
  const notices = await allNoticesOf(COMMUNITY, MEMBER);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].post, "p1");
});

test("allNoticesOf: a list reply in an unknown shape refuses rather than copying none", async () => {
  const shapes: unknown[] = [...unknownReplies, [null], [undefined], ["x"], [{}], [[1]], [[null]], [["a"], "extra"]];
  for (const reply of shapes) {
    store.clear();
    await withPipeline(async () => reply as unknown[], async () => {
      await assert.rejects(allNoticesOf(COMMUNITY, MEMBER), `list reply ${JSON.stringify(reply)}`);
    });
  }
});

test("tell: a healthy list size takes the notice's room before filing it", async () => {
  store.clear();
  const sent: Batch = [];
  await withPipeline(async (batch, original) => { sent.push(...batch); return original(batch); }, async () => {
    await tell(COMMUNITY, [MEMBER], { kind: "mention", post: "p2", comment: "", by: OTHER, words: "synthetic" }, room);
  });
  const names = sent.map((c) => (c[0] === "EVAL" && String(c[1]).startsWith(TAKE_DATA) ? "TAKE" : String(c[0])));
  assert.deepEqual(names, ["ZCARD", "TAKE", "ZADD", "ZREMRANGEBYRANK"]);
  assert.equal(await store.pipeline([["ZCARD", LIST]]).then(([v]) => v), 1);
});

test("tell: a list size in an unknown shape files nothing, so nothing is kept without its room", async () => {
  const shapes: unknown[] = [...unknownReplies, [null], [undefined], ["5"], [Number.NaN], [-1], [1.5], [{}]];
  for (const reply of shapes) {
    store.clear();
    const sent: Batch = [];
    await withPipeline(async (batch, original) => {
      sent.push(...batch);
      return batch[0][0] === "ZCARD" ? (reply as unknown[]) : original(batch);
    }, async () => {
      await tell(COMMUNITY, [MEMBER], { kind: "mention", post: "p3", comment: "", by: OTHER, words: "synthetic" }, room);
    });
    assert.deepEqual(sent.map((c) => c[0]), ["ZCARD"], `ZCARD reply ${JSON.stringify(reply)}`);
    assert.equal(await store.pipeline([["ZCARD", LIST]]).then(([v]) => v), 0);
  }
});
