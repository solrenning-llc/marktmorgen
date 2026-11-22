/**
 * A person's copy reads a store's email platform jobs in pages (#5125; Claude 1 coord, mail 0da0, 22 November 2026).
 * A store may have more jobs waiting than one request may read: a fixed bound that fails closed would deny the copy to
 * that person, and one that reads past the budget is unbounded. So lib/email-sync.ts syncJobsPage takes every read
 * from the request's ReadBudget before it is sent, stops with a resume when the next read does not fit, and the pages
 * together hold every job of theirs one whole read finds, each once. Here the store has more jobs waiting than
 * 10,000 (QUEUED_PAGE x 20), the fixed bound the coordinator refused. Synthetic data only; nothing is sent anywhere.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LOG_SIZE, QUEUED_PAGE, forgetSyncPerson, syncJobsPage } from "@/lib/email-sync";
import { ReadBudget } from "@/lib/copy-pages";
import { store as redis } from "./redis-stub";

const STATS = "copypages0001";
const PERSON = "dana.reyes@example.com";
/** More jobs waiting than the refused fixed bound of 20 pages of QUEUED_PAGE could read. */
const WAITING = QUEUED_PAGE * 20 + 700;
/** Of them, the person's own, spread through the index. */
const THEIRS_EVERY = 997;

type Batch = (string | number)[][];
const original = redis.pipeline.bind(redis);
let sent = 0;
redis.pipeline = (async (batch: Batch) => {
  sent += batch.length;
  return original(batch);
}) as typeof redis.pipeline;

const id = (i: number) => `esj_${i.toString(16).padStart(24, "0")}`;
const job = (i: number, email: string) =>
  JSON.stringify({ id: id(i), statsId: STATS, email, firstName: null, products: [], title: "Synthetic", source: "purchase", attempts: 0, state: "queued", next: 1, lastError: "", note: "", lastAt: 0, createdAt: 1 });

function seed(): Set<string> {
  redis.clear();
  const theirs = new Set<string>();
  for (let i = 0; i < WAITING; i += 1) {
    const mine = i % THEIRS_EVERY === 0;
    redis.run(["SET", `nl:esync:j:${id(i)}`, job(i, mine ? PERSON : `other${i}@example.com`)]);
    redis.run(["SADD", `nl:esync:qd:${STATS}`, id(i)]);
    if (mine) theirs.add(id(i));
  }
  // The newest jobs are in the log too, as queuePerson leaves them: one of theirs among them, read once.
  for (let i = WAITING - LOG_SIZE; i < WAITING; i += 1) redis.run(["LPUSH", `nl:esync:log:${STATS}`, id(i)]);
  return theirs;
}

/** Every page, each with a fresh budget of `commands`, until there is no resume; what each page sent. */
async function allPages(commands: number): Promise<{ ids: string[]; pages: number; most: number }> {
  const ids: string[] = [];
  let resume: string | undefined;
  let pages = 0;
  let most = 0;
  do {
    sent = 0;
    const page = await syncJobsPage(STATS, PERSON, new ReadBudget(commands), resume);
    most = Math.max(most, sent);
    ids.push(...page.jobs.map((j) => j.id));
    resume = page.resume;
    pages += 1;
    assert.ok(pages < 10_000, "the pages make progress");
  } while (resume !== undefined);
  return { ids, pages, most };
}

test("past the fixed bound, the pages together hold every job of theirs, each once, inside each request's budget", async () => {
  const theirs = seed();
  for (const commands of [20_000, 2_000, 600]) {
    const { ids, pages, most } = await allPages(commands);
    assert.deepEqual([...ids].sort(), [...theirs].sort(), `every job of theirs, each once (budget ${commands})`);
    assert.ok(most <= commands, `no page sends more than its budget (budget ${commands}: ${most})`);
    if (commands < WAITING) assert.ok(pages > 1, `a budget smaller than the store's jobs takes more than one page (budget ${commands})`);
  }
});

test("with no room even to begin, a page reads nothing and gives where to begin", async () => {
  seed();
  sent = 0;
  assert.deepEqual(await syncJobsPage(STATS, PERSON, new ReadBudget(0)), { jobs: [], resume: "l" });
  assert.equal(sent, 0, "nothing is sent");
  const mid = await syncJobsPage(STATS, PERSON, new ReadBudget(0), "q:17");
  assert.deepEqual(mid, { jobs: [], resume: "q:17" }, "a later page with no room keeps its place");
});

test("a position that is not its own is refused, never read as the start", async () => {
  seed();
  await assert.rejects(() => syncJobsPage(STATS, PERSON, new ReadBudget(100), "x:1"));
});

test("past the refused bound, the person's erasure reads the store's index to the end and deletes every job of theirs", async () => {
  const theirs = seed();
  assert.equal(await forgetSyncPerson(STATS, PERSON), theirs.size, "every job of theirs is deleted, none left past a fixed count");
  for (const id of theirs) assert.equal(redis.run(["GET", `nl:esync:j:${id}`]), null, "its record is gone");
  assert.equal(redis.run(["SCARD", `nl:esync:qd:${STATS}`]), WAITING - theirs.size, "only their ids leave the store's index");
});
