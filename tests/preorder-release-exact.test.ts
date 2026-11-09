/**
 * A released product's pre-orders are handed over by a job (lib/preorders.ts runPreorderReleases) that is let go only
 * on a confirmed reading (CX-123 rule 24; Claude 4's Stripe hand-over audit, proof
 * proofs/c4-sweeps/stripehand/p1-preorder-release.proof.ts on claude4/sweep-proofs):
 *
 *   - its pre-orders read in another shape, or its store or product not read, keep the job for the next run, never
 *     drop it (before: the job was removed and the paid pre-orders were never handed over);
 *   - a pre-order record that does not read keeps the job and is said, never silently left out;
 *   - one job that throws (a listing that does not read) does not stop the others;
 *   - waitingCount reads exactly: an unknown answer throws, never "none waiting" (a product removed, a release never
 *     queued), and a record that does not read counts as waiting.
 *
 * Money: these are paid pre-orders. Real MemoryRedis; only the reply under test is replaced, after it ran.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { queueRelease, runPreorderReleases, waitingCount } from "@/lib/preorders";
import { store as redis } from "./redis-stub";
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";

const SID = "pre0stats0001";
const PID = "prod00000001";
const OTHER = "prod00000002";
const SESSION = "cs_test_preorderproof000001";
const job = (pid: string) => `${SID}|${pid}|harbor`;
const entriesKey = (pid: string) => `nl:pre:${SID}:${pid}`;
const store = { statsId: SID, sid: "", handle: "harbor", stripeAccountId: "acct_1Proof00000001", pastBuyers: true, name: "Harbor", language: "en", email: "owner@example.com", previousHandles: [], releasedHandles: [] } as unknown as Store;
const listing = (id: string) => ({ id, title: `Synthetic ${id}`, course: null }) as unknown as Listing;
const deps = { base: "https://example.com/@harbor", from: "Harbor <x@example.com>", ordersLink: async () => null, recordStart: async () => {} };
const waitingEntry = (to: string) => JSON.stringify({ to, at: 1_700_000_000, pi: "" });

function seed(pids: string[] = [PID]) {
  redis.clear();
  for (const pid of pids) {
    redis.run(["SADD", "nl:pre:jobs", job(pid)]);
    redis.run(["HSET", entriesKey(pid), SESSION, waitingEntry(`buyer-${pid}@example.com`)]);
  }
}
const jobs = () => redis.run(["SMEMBERS", "nl:pre:jobs"]) as string[];
const given = (pid: string, session = SESSION) => Boolean(JSON.parse(String(redis.run(["HGET", entriesKey(pid), session]))).given);

type Opts = { hgetall?: (r: unknown) => unknown; product?: (store: Store, pid: string) => Promise<Listing | null>; store?: Store | null };
async function release(opts: Opts = {}): Promise<number> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (c: (string | number)[][]) => {
    const a = await real(c);
    return c[0]?.[0] === "HGETALL" && String(c[0]?.[1]).startsWith("nl:pre:") && opts.hgetall ? [opts.hgetall(a[0])] : a;
  }) as typeof redis.pipeline;
  const errors = console.error;
  console.error = () => {};
  try {
    return await runPreorderReleases(async () => (opts.store === undefined ? store : opts.store), opts.product ?? (async (_s: Store, pid: string) => listing(pid)), () => deps, Date.now() + 10_000);
  } finally {
    redis.pipeline = real;
    console.error = errors;
  }
}

test("control: a healthy reading hands the pre-order over and lets the job go", async () => {
  seed();
  assert.equal(await release(), 1);
  assert.equal(given(PID), true);
  assert.deepEqual(jobs(), []);
});

for (const [label, opts] of [
  ["its pre-orders answered with no result", { hgetall: () => undefined }],
  ["its pre-orders answered as an object", { hgetall: () => ({}) }],
  ["its pre-orders answered as an odd list", { hgetall: (r: unknown) => (r as unknown[]).slice(0, 1) }],
  ["its product not read", { product: async () => null }],
  ["its store not read", { store: null }],
] as [string, Opts][]) {
  test(`${label}: the job is kept, and the next run hands the pre-order over`, async () => {
    seed();
    assert.equal(await release(opts), 0);
    assert.deepEqual(jobs(), [job(PID)], "the job is kept");
    assert.equal(given(PID), false);
    assert.equal(await release(), 1, "the read healed: handed over");
    assert.equal(given(PID), true);
    assert.deepEqual(jobs(), []);
  });
}

test("one job whose product read throws does not stop the others", async () => {
  seed([PID, OTHER]);
  const handed = await release({ product: async (_s, pid) => (pid === PID ? Promise.reject(new Error("a listing that does not read")) : listing(pid)) });
  assert.equal(handed, 1);
  assert.equal(given(OTHER), true, "the other product's pre-order is handed over");
  assert.equal(given(PID), false);
  assert.deepEqual(jobs(), [job(PID)], "the one that threw is kept");
});

test("a pre-order record that does not read keeps the job, beside one handed over", async () => {
  seed();
  redis.run(["HSET", entriesKey(PID), "cs_test_preordercorrupt00001", "{not json"]);
  assert.equal(await release(), 1);
  assert.equal(given(PID), true);
  assert.deepEqual(jobs(), [job(PID)], "kept for the record that does not read");
});

test("a job whose pre-orders are all handed over or refunded is let go", async () => {
  seed();
  redis.run(["HSET", entriesKey(PID), SESSION, JSON.stringify({ to: "x@example.com", at: 1, pi: "", given: 2 })]);
  assert.equal(await release(), 0);
  assert.deepEqual(jobs(), []);
});

test("waitingCount: exact, a record that does not read counts as waiting, an unknown answer throws", async () => {
  seed();
  assert.equal(await waitingCount(store, PID), 1);
  assert.equal(await waitingCount(store, "prod00000009"), 0, "no pre-orders: none waiting");
  redis.run(["HSET", entriesKey(PID), "cs_test_preordercorrupt00001", "{not json"]);
  assert.equal(await waitingCount(store, PID), 2);
  for (const reply of [undefined, {}, [1]]) {
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (c: (string | number)[][]) => (c[0]?.[0] === "HVALS" ? [reply] : real(c))) as typeof redis.pipeline;
    try {
      await assert.rejects(() => waitingCount(store, PID), `HVALS ${JSON.stringify(reply)} is unknown`);
      await assert.rejects(() => queueRelease(store, PID), "a release is not left unqueued on a guess");
    } finally {
      redis.pipeline = real;
    }
  }
});

test("queueRelease queues a product whose only pre-order record does not read", async () => {
  redis.clear();
  redis.run(["HSET", entriesKey(PID), "cs_test_preordercorrupt00001", "{not json"]);
  await queueRelease(store, PID);
  assert.deepEqual(jobs(), [job(PID)]);
});

// Codex C2's residual (review 5807688707, codex/c-review-2963-preorder-release@b0317404, proofs/c2/review-2963.mjs),
// kept with credit: after the exact HGETALL, the hand-over reads the one entry again with HGET. A reply to that HGET
// in an unknown shape was parsed as "no entry": the hand-over answered skip, the job was let go, and the paid
// pre-order was never handed over. Unknown now throws: the job is kept, nothing is handed over, the entry is not
// marked given. A confirmed absence (HGET null) is still nothing to hand over.
const unknownEntryReplies: [string, (raw: unknown) => unknown[]][] = [
  ["no reply", () => []],
  ["undefined", () => [undefined]],
  ["false", () => [false]],
  ["broken JSON", () => ["{"]],
  ["one reply too many", (raw) => [raw, "extra"]],
  ["a hole", () => Array<unknown>(1)],
];
async function releaseWithEntryReply(answer: (raw: unknown) => unknown[]): Promise<number> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (c: (string | number)[][]) => {
    const a = await real(c);
    return c.length === 1 && c[0][0] === "HGET" && c[0][1] === entriesKey(PID) && c[0][2] === SESSION ? answer(a[0]) : a;
  }) as typeof redis.pipeline;
  const errors = console.error;
  console.error = () => {};
  try {
    return await runPreorderReleases(async () => store, async (_s: Store, pid: string) => listing(pid), () => deps, Date.now() + 10_000);
  } finally {
    redis.pipeline = real;
    console.error = errors;
  }
}
for (const [name, answer] of unknownEntryReplies) {
  test(`the hand-over's own read of the entry answered in an unknown shape (${name}): nothing handed over, the job kept`, async () => {
    seed();
    assert.equal(await releaseWithEntryReply(answer), 0);
    assert.deepEqual(jobs(), [job(PID)], "the paid pre-order's job is kept for the next run");
    assert.equal(given(PID), false, "the entry is not marked given");
    // The next run, with Redis answering again, hands it over once.
    assert.equal(await release(), 1);
    assert.deepEqual(jobs(), []);
    assert.equal(given(PID), true);
  });
}

test("control: the hand-over's own read healthy hands over once; an entry confirmed gone (HGET null) is nothing to hand over", async () => {
  seed();
  assert.equal(await releaseWithEntryReply((raw) => [raw]), 1);
  assert.deepEqual(jobs(), []);
  assert.equal(given(PID), true);
  seed();
  assert.equal(await releaseWithEntryReply(() => [null]), 0);
  assert.deepEqual(jobs(), [], "confirmed absence: nothing left to hand over");
});
