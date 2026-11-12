/**
 * CX-123 rule 24 in tell (lib/community-notify.ts): the size of each member's
 * notice list is read only in its exact shape. A ZCARD reply that is missing,
 * cut short or of another shape is not "a list with room" nor "a full list":
 * on main it could file a notice whose room in the store's data room was
 * never taken ("OK" counts as full, so nothing is taken, yet the notice is
 * still added). Now nothing is filed, and tell still never throws into the
 * caller (a comment never fails because its notification did).
 *
 * The confirmed-empty and healthy controls stay as they were: ZCARD, the
 * room taken, ZADD, the trim.
 *
 * Runs the real code against the in-memory Redis (tests/redis-stub.ts),
 * synthetic ids only, no provider. Built from claude6/r24-community-handle
 * (commit a217f5dcdc), whose other parts main already covers or #3095 holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tell } from "@/lib/community-notify";
import { store } from "./redis-stub";

const COMMUNITY = "notice-size-replies";
const MEMBER = "c3c3c3c3c3c3";
const SECOND = "e5e5e5e5e5e5";
const OTHER = "d4d4d4d4d4d4";
const LIST = `nl:cm:${COMMUNITY}:nt:${MEMBER}`;
const SECOND_LIST = `nl:cm:${COMMUNITY}:nt:${SECOND}`;
const room = { sid: "notice-size-replies-1", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_synthetic", trialEnds: 0, planEndedAt: "" };
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

const names = (sent: Batch) => sent.map((c) => (c[0] === "EVAL" && String(c[1]).startsWith(TAKE_DATA) ? "TAKE" : String(c[0])));
const size = (key: string) => store.pipeline([["ZCARD", key]]).then(([v]) => v);

test("tell: a confirmed empty list takes the notice's room before filing it", async () => {
  store.clear();
  const sent: Batch = [];
  await withPipeline(async (batch, original) => { sent.push(...batch); return original(batch); }, async () => {
    await tell(COMMUNITY, [MEMBER], { kind: "mention", post: "p2", comment: "", by: OTHER, words: "synthetic" }, room);
  });
  assert.deepEqual(names(sent), ["ZCARD", "TAKE", "ZADD", "ZREMRANGEBYRANK"]);
  assert.equal(await size(LIST), 1);
});

test("tell: two healthy lists both grow, each with its room", async () => {
  store.clear();
  await tell(COMMUNITY, [MEMBER], { kind: "reply", post: "p1", comment: "", by: OTHER, words: "synthetic" }, room);
  const sent: Batch = [];
  await withPipeline(async (batch, original) => { sent.push(...batch); return original(batch); }, async () => {
    await tell(COMMUNITY, [MEMBER, SECOND], { kind: "mention", post: "p2", comment: "", by: OTHER, words: "synthetic" }, room);
  });
  assert.deepEqual(names(sent), ["ZCARD", "ZCARD", "TAKE", "ZADD", "ZREMRANGEBYRANK", "ZADD", "ZREMRANGEBYRANK"]);
  assert.equal(await size(LIST), 2);
  assert.equal(await size(SECOND_LIST), 1);
});

test("tell: a list size in an unknown shape files nothing, so nothing is kept without its room", async () => {
  const shapes: unknown[] = [null, undefined, "OK", {}, [], [1, 2], [null], [undefined], ["5"], [Number.NaN], [-1], [1.5], [{}]];
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
    assert.equal(await size(LIST), 0, `ZCARD reply ${JSON.stringify(reply)}`);
  }
});

test("tell: one unknown size among two files nothing for either", async () => {
  store.clear();
  const sent: Batch = [];
  await withPipeline(async (batch, original) => {
    sent.push(...batch);
    return batch[0][0] === "ZCARD" ? [0, "OK"] : original(batch);
  }, async () => {
    await tell(COMMUNITY, [MEMBER, SECOND], { kind: "mention", post: "p4", comment: "", by: OTHER, words: "synthetic" }, room);
  });
  assert.deepEqual(sent.map((c) => c[0]), ["ZCARD", "ZCARD"]);
  assert.equal(await size(LIST), 0);
  assert.equal(await size(SECOND_LIST), 0);
});
