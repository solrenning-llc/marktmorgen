/**
 * Jobs already waiting on the shared queue when the store's queued index (nl:esync:qd:<statsId>, #5135) ships were
 * queued before the index existed, so they are not in it (Claude 1 DKvY's MEDIUM on #5135, mail 4534). A person's copy
 * and erasure that read only the index would miss them, and the record holding the address would outlive the erasure.
 * So: until the five-minute job has filled the indexes from the shared queue once (syncDue, the fill mark), the copy
 * and both erasures read the store's waiting jobs from the shared queue, as main did; after it, from the index only.
 * Synthetic data only; nothing is sent anywhere.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QUEUE_KEY, fillQueuedIndexes, forgetStoreSync, forgetSyncPerson, syncDue, syncJobsPage } from "@/lib/email-sync";
import { ReadBudget } from "@/lib/copy-pages";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const STATS = "backfill00001";
const PERSON = "dana.reyes@example.com";
const ID = `esj_${"ab".repeat(12)}`;
const OTHER = `esj_${"cd".repeat(12)}`;

/** A job queued before the index existed: its record and its queue member, in no log and no index. */
function seedOld(): void {
  redis.clear();
  const job = (id: string, email: string) =>
    JSON.stringify({ id, statsId: STATS, email, firstName: null, products: [], title: "Synthetic", source: "purchase", attempts: 1, state: "retrying", next: Date.now() + 3_600_000, lastError: "", note: "", lastAt: 1, createdAt: 1 });
  redis.run(["SET", `nl:esync:j:${ID}`, job(ID, PERSON)]);
  redis.run(["SET", `nl:esync:j:${OTHER}`, job(OTHER, "other@example.com")]);
  // Due in an hour, so the five-minute job does not try them here: only the fill touches them.
  redis.run(["ZADD", QUEUE_KEY, Date.now() + 3_600_000, `${STATS}|${ID}`]);
  redis.run(["ZADD", QUEUE_KEY, Date.now() + 3_600_000, `${STATS}|${OTHER}`]);
}

type Batch = (string | number)[][];
const original = redis.pipeline.bind(redis);
const seen: Batch = [];
redis.pipeline = (async (batch: Batch) => {
  seen.push(...batch);
  return original(batch);
}) as typeof redis.pipeline;
const scannedShared = () => seen.filter((c) => c[0] === "ZSCAN" && c[1] === QUEUE_KEY).length;

test("before the indexes are filled, the copy and the person's erasure read the shared queue and find the old job", async () => {
  seedOld();
  const page = await syncJobsPage(STATS, PERSON, new ReadBudget(20_000));
  assert.deepEqual(page.jobs.map((j) => j.id), [ID], "the copy holds it");
  assert.equal(page.resume, undefined, "on one page");
  assert.equal(await forgetSyncPerson(STATS, PERSON), 1, "the erasure deletes it");
  assert.equal(redis.run(["GET", `nl:esync:j:${ID}`]), null, "its record is gone");
  assert.equal(redis.run(["ZSCORE", QUEUE_KEY, `${STATS}|${ID}`]), null, "and its queue member");
  assert.notEqual(redis.run(["GET", `nl:esync:j:${OTHER}`]), null, "another person's job stays");
});

test("before the indexes are filled, the store's erasure takes its old jobs off the shared queue", async () => {
  seedOld();
  await forgetStoreSync(STATS);
  assert.equal(redis.run(["GET", `nl:esync:j:${ID}`]), null);
  assert.equal(redis.run(["ZSCORE", QUEUE_KEY, `${STATS}|${OTHER}`]), null);
});

test("the five-minute job fills the indexes once; then the copy finds the old job without reading the shared queue", async () => {
  seedOld();
  await syncDue(Date.now() + 60_000);
  assert.equal(redis.run(["GET", "nl:esync:qdfill:done"]), "1", "the fill finished and says so");
  assert.equal(redis.run(["SISMEMBER", `nl:esync:qd:${STATS}`, ID]), 1, "the old job is in its store's index");
  seen.length = 0;
  const page = await syncJobsPage(STATS, PERSON, new ReadBudget(20_000));
  assert.deepEqual(page.jobs.map((j) => j.id), [ID], "the copy holds it");
  assert.equal(scannedShared(), 0, "and read only the store's own index");
  seen.length = 0;
  assert.equal(await forgetSyncPerson(STATS, PERSON), 1, "the erasure deletes it");
  assert.equal(scannedShared(), 0, "the erasure too");
});

test("a fill cut short keeps its cursor and goes on from it; a mark in another shape is never taken as filled", async () => {
  seedOld();
  assert.equal(await fillQueuedIndexes(Date.now() - 1), "more", "no page started after the deadline");
  assert.equal(redis.run(["GET", "nl:esync:qdfill:done"]), null);
  redis.run(["SET", "nl:esync:qdfill:done", "yes"]);
  await assert.rejects(() => syncJobsPage(STATS, PERSON, new ReadBudget(20_000)), UnknownReplyError);
});
