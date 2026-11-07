/**
 * stopCounting (lib/mail-clicks.ts) takes back the permission to count a
 * reader's link use: it reads their list row through the token, then writes
 * the row back without `clicks` in a second trip. Whatever was written to the
 * row in between is overwritten with the old copy: an unsubscribe made at the
 * same moment comes back as subscribed, and a row erased in between is made
 * again (CX-123 rule 30, the same pattern as forgetClicksPerson in
 * tests/mail-clicks-forget-race.test.ts: what decides a write is read where
 * the write happens).
 *
 * Synthetic data only, the in-memory Redis (tests/redis-stub.ts), no provider.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { keyIndex, linkKeyOf, rememberLinkKeys, stopCounting } from "@/lib/mail-clicks";
import { leadsKey, tokenKey, unsubscribe } from "@/lib/contacts";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";

type Batch = (string | number)[][];
const LIST = "list-stop-race";
const EMAIL = "reader-stop@example.test";
const TOKEN = "e".repeat(40);

const row = (extra: Record<string, unknown> = {}) => JSON.stringify({ agreed: true, clicks: "2026-11-01T12:00:00.000Z", t: TOKEN, ...extra });
const readRow = async () => {
  const [raw] = await redisPipeline([["HGET", leadsKey(LIST), EMAIL]]);
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
};
const exists = async (key: string) => (await redisPipeline([["EXISTS", key]]))[0] === 1;
const isRowRead = (batch: Batch) => batch.some((c) => c[0] === "HGET" && c[1] === leadsKey(LIST) && c[2] === EMAIL);

/** Runs `between` after the first `times` reads of the person's row were answered. */
async function withWriteAfterRead(between: () => Promise<void>, run: () => Promise<void>, times = 1): Promise<number> {
  const original = redis.pipeline.bind(redis);
  let done = 0;
  const wrapped = (async (batch: Batch) => {
    const replies = await original(batch);
    if (done < times && isRowRead(batch)) {
      done += 1;
      redis.pipeline = original as typeof redis.pipeline;
      try {
        await between();
      } finally {
        if (done < times) redis.pipeline = wrapped;
      }
    }
    return replies;
  }) as typeof redis.pipeline;
  redis.pipeline = wrapped;
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
    ["HSET", leadsKey(LIST), EMAIL, row()],
    ["SET", tokenKey(TOKEN), `${LIST}|${EMAIL}|store-synthetic`],
  ]);
  await rememberLinkKeys([TOKEN]);
}

test("stopCounting: an unsubscribe written between the read and the write stays, never written back as subscribed", async () => {
  await seed();
  let found: boolean | null = null;
  const interleaved = await withWriteAfterRead(async () => {
    assert.ok(await unsubscribe(TOKEN));
  }, async () => {
    found = await stopCounting(TOKEN);
  });
  assert.equal(interleaved, 1, "the unsubscribe ran between the read and the write");
  const after = await readRow();
  assert.equal(after?.unsub, true, "the reader who left is never put back on the list");
  assert.equal(Boolean(after?.clicks), false);
  assert.equal(found, true);
  assert.equal(await exists(keyIndex(linkKeyOf(TOKEN))), false, "their links lead nowhere");
});

test("stopCounting: a row erased between the read and the write is never made again", async () => {
  await seed();
  const interleaved = await withWriteAfterRead(async () => {
    await redisPipeline([["HDEL", leadsKey(LIST), EMAIL]]);
  }, async () => {
    await stopCounting(TOKEN);
  });
  assert.equal(interleaved, 1);
  assert.equal(await readRow(), null, "an erased person's row is never written back");
  assert.equal(await exists(keyIndex(linkKeyOf(TOKEN))), false);
});

test("stopCounting: another change to the row between the read and the write is kept, and the permission still goes", async () => {
  await seed();
  const interleaved = await withWriteAfterRead(async () => {
    await redisPipeline([["HSET", leadsKey(LIST), EMAIL, row({ tags: ["synthetic-tag"] })]]);
  }, async () => {
    assert.equal(await stopCounting(TOKEN), true);
  });
  assert.equal(interleaved, 1);
  const after = await readRow();
  assert.deepEqual(after?.tags, ["synthetic-tag"], "the change made meanwhile is never overwritten");
  assert.equal(Boolean(after?.clicks), false, "the permission is taken back");
});

test("stopCounting: a row that keeps changing is refused after a few tries, never overwritten", async () => {
  await seed();
  let n = 0;
  let thrown: unknown = null;
  await withWriteAfterRead(async () => {
    n += 1;
    await redisPipeline([["HSET", leadsKey(LIST), EMAIL, row({ tags: [`tag-${n}`] })]]);
  }, async () => {
    try {
      await stopCounting(TOKEN);
    } catch (error) {
      thrown = error;
    }
  }, 50);
  assert.ok(thrown instanceof Error, "it gives up with an error, it does not report the permission taken back");
  assert.ok(n <= 5, `bounded tries, got ${n}`);
  assert.deepEqual((await readRow())?.tags, [`tag-${n}`], "the last change made meanwhile is what stays");
});

test("stopCounting: the healthy press takes the permission back in the same trips and keeps them on the list", async () => {
  await seed();
  const original = redis.pipeline.bind(redis);
  let trips = 0;
  redis.pipeline = (async (batch: Batch) => {
    trips += 1;
    return original(batch);
  }) as typeof redis.pipeline;
  try {
    assert.equal(await stopCounting(TOKEN), true);
  } finally {
    redis.pipeline = original as typeof redis.pipeline;
  }
  assert.equal(trips, 3, "the token, the row, one write");
  const after = await readRow();
  assert.equal(Boolean(after?.clicks), false);
  assert.equal(after?.agreed, true);
  assert.equal(after?.t, TOKEN);
  assert.equal(await exists(keyIndex(linkKeyOf(TOKEN))), false);
  // A second press finds the row without the permission and writes nothing more.
  assert.equal(await stopCounting(TOKEN), true);
  assert.equal(Boolean((await readRow())?.clicks), false);
  // An unknown token is not found.
  assert.equal(await stopCounting("f".repeat(40)), false);
});

test("stopCounting: an unknown reply to the write is refused, never read as done", async () => {
  await seed();
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => {
    if (batch.some((c) => c[0] === "EVAL" || (c[0] === "HSET" && c[1] === leadsKey(LIST)))) return batch.map(() => "OK");
    return original(batch);
  }) as typeof redis.pipeline;
  try {
    await assert.rejects(stopCounting(TOKEN));
  } finally {
    redis.pipeline = original as typeof redis.pipeline;
  }
});
