/**
 * Jobs already waiting on the shared queue when the store's queued index (nl:esync:qd:<statsId>, #5135) ships were
 * queued before the index existed, so they are not in it (Claude 1 DKvY's MEDIUM on #5135, mail 4534). A person's copy
 * and erasure that read only the index would miss them, and the record holding the address would outlive the erasure.
 * So: until the five-minute job has filled the index from the shared queue once (syncDue, the fill marker), the copy and
 * both erasures say they cannot finish, never an answer with a part missing; after it, they find those jobs.
 * Synthetic data only; nothing is sent anywhere.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QUEUE_KEY, forgetStoreSync, forgetSyncPerson, syncDue, syncJobsPage } from "@/lib/email-sync";
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

const unknown = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "answered";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : String(error);
  }
};

test("before the index is filled, the copy and both erasures say they cannot finish, never miss the job", async () => {
  seedOld();
  assert.equal(await unknown(() => syncJobsPage(STATS, PERSON, new ReadBudget(20_000))), "unknown", "the copy");
  assert.equal(await unknown(() => forgetSyncPerson(STATS, PERSON)), "unknown", "the person's erasure");
  assert.notEqual(redis.run(["GET", `nl:esync:j:${ID}`]), null, "(nothing was deleted by a read that could not finish)");
  assert.equal(await unknown(() => forgetStoreSync(STATS)), "unknown", "the store's erasure");
});

test("once the five-minute job has filled the index, the copy and the person's erasure find the old job", async () => {
  seedOld();
  await syncDue(Date.now() + 60_000);
  const page = await syncJobsPage(STATS, PERSON, new ReadBudget(20_000));
  assert.deepEqual(page.jobs.map((j) => j.id), [ID], "the copy holds it");
  assert.equal(await forgetSyncPerson(STATS, PERSON), 1, "the erasure deletes it");
  assert.equal(redis.run(["GET", `nl:esync:j:${ID}`]), null, "its record is gone");
  assert.equal(redis.run(["ZSCORE", QUEUE_KEY, `${STATS}|${ID}`]), null, "and its queue member");
  assert.notEqual(redis.run(["GET", `nl:esync:j:${OTHER}`]), null, "another person's job stays");
});

test("once filled, the store's erasure takes the old jobs off the queue", async () => {
  seedOld();
  await syncDue(Date.now() + 60_000);
  await forgetStoreSync(STATS);
  assert.equal(redis.run(["GET", `nl:esync:j:${ID}`]), null);
  assert.equal(redis.run(["ZSCORE", QUEUE_KEY, `${STATS}|${OTHER}`]), null);
});
