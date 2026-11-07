/**
 * forgetClicksPerson (lib/mail-clicks.ts) erases a person's link use: what
 * was counted, and the key their links carried, found through the token kept
 * in their list row. Read and delete in two trips leave a gap: when the row
 * gets a new token between the read and the delete (they joined again), the
 * delete takes the old token's key and leaves the new one, which leads back
 * to them for 400 days, and the erasure says it is done (CX-123 rule 24:
 * what decides a deletion is read where the deletion happens).
 *
 * Synthetic data only, the in-memory Redis (tests/redis-stub.ts), no provider.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { forgetClicksPerson, keyIndex, linkKeyOf, rememberLinkKeys } from "@/lib/mail-clicks";
import { leadsKey } from "@/lib/contacts";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";

type Batch = (string | number)[][];
const LIST = "list-forget-race";
const EMAIL = "reader-race@example.test";
const NEIGHBOUR = "neighbour-race@example.test";
const OLD = "b".repeat(40);
const NEW = "c".repeat(40);
const THEIRS = "d".repeat(40);

const row = (token: string) => JSON.stringify({ agreed: true, clicks: true, t: token });
const exists = async (key: string) => (await redisPipeline([["EXISTS", key]]))[0] === 1;

/** Runs `between` once, right after the first read of the person's row was answered. */
async function withWriteAfterRead(between: () => Promise<void>, run: () => Promise<void>): Promise<boolean> {
  const original = redis.pipeline.bind(redis);
  let done = false;
  redis.pipeline = (async (batch: Batch) => {
    const replies = await original(batch);
    if (!done && batch.some((c) => c[0] === "HGET" && c[1] === leadsKey(LIST) && c[2] === EMAIL)) {
      done = true;
      redis.pipeline = original as typeof redis.pipeline;
      await between();
    }
    return replies;
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = original as typeof redis.pipeline;
  }
  return done;
}

async function seed(): Promise<void> {
  redis.clear();
  await redisPipeline([
    ["HSET", leadsKey(LIST), EMAIL, row(OLD)],
    ["HSET", leadsKey(LIST), NEIGHBOUR, row(THEIRS)],
  ]);
  await rememberLinkKeys([OLD, THEIRS]);
}

test("forgetClicksPerson: a new token written between the read and the delete has its key erased too", async () => {
  await seed();
  const interleaved = await withWriteAfterRead(async () => {
    await redisPipeline([["HSET", leadsKey(LIST), EMAIL, row(NEW)]]);
    await rememberLinkKeys([NEW]);
  }, async () => {
    await forgetClicksPerson(LIST, EMAIL);
  });
  assert.ok(interleaved, "the new token was written between the read and the delete");
  assert.equal(await exists(keyIndex(linkKeyOf(NEW))), false, "the key their links carry now is erased, never left leading back to them");
  assert.equal(await exists(keyIndex(linkKeyOf(OLD))), false, "the key their links carried before is erased too");
  assert.equal(await exists(keyIndex(linkKeyOf(THEIRS))), true, "another person's key on the same list stays");
  assert.equal(typeof (await redisPipeline([["HGET", leadsKey(LIST), EMAIL]]))[0], "string", "the row itself is lib/contacts.ts's to erase, after this");
});

test("forgetClicksPerson: with nothing written in between, the person's key goes and the count is the same", async () => {
  await seed();
  const gone = await forgetClicksPerson(LIST, EMAIL);
  assert.equal(gone, 1, "the key their links carried (nothing was counted yet)");
  assert.equal(await exists(keyIndex(linkKeyOf(OLD))), false);
  assert.equal(await exists(keyIndex(linkKeyOf(THEIRS))), true);
});

test("forgetClicksPerson: a row that keeps changing is never said erased, and nothing is taken for gone", async () => {
  await seed();
  const original = redis.pipeline.bind(redis);
  let turn = 0;
  redis.pipeline = (async (batch: Batch) => {
    const replies = await original(batch);
    if (batch.some((c) => c[0] === "HGET" && c[1] === leadsKey(LIST) && c[2] === EMAIL)) {
      turn += 1;
      await original([["HSET", leadsKey(LIST), EMAIL, row(String(turn % 10).repeat(40))]]);
    }
    return replies;
  }) as typeof redis.pipeline;
  try {
    await assert.rejects(forgetClicksPerson(LIST, EMAIL));
  } finally {
    redis.pipeline = original as typeof redis.pipeline;
  }
  assert.equal(turn, 3, "read three times, then it gives up");
  assert.equal(await exists(keyIndex(linkKeyOf(OLD))), true, "nothing was deleted while the row was not what was read");
});

test("forgetClicksPerson: a deletion reply in an unknown shape is said as not done, never as a count", async () => {
  const shapes: unknown[] = [[], [null], [undefined], ["1"], [-2], [1.5], [Number.NaN], [3], [{}], [[1]]];
  for (const reply of shapes) {
    await seed();
    const original = redis.pipeline.bind(redis);
    redis.pipeline = (async (batch: Batch) => (batch[0][0] === "EVAL" ? reply : original(batch))) as typeof redis.pipeline;
    try {
      await assert.rejects(forgetClicksPerson(LIST, EMAIL), `deletion reply ${JSON.stringify(reply)}`);
    } finally {
      redis.pipeline = original as typeof redis.pipeline;
    }
  }
});
