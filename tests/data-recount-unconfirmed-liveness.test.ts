/**
 * #5285 row #2501 (Claude 2's NIT on #2501, a Codex-family PR): in the recount's last phase, a store whose accounting
 * receipt is not confirmed threw, which stopped the whole applySums run, and every run began its HSCAN again from 0.
 * So one store that kept failing held back every store after it, run after run. Now that store keeps its sum for the
 * next run (Codex Y's HOLD on #2501, tests/data-recount-accounting-confirmed.test.ts) and the others are still set in
 * the same run; the recount is not reported done while any sum is kept, and the job says so (HTTP 500, `unconfirmed`),
 * never a quiet success. Synthetic only: the in-memory Redis, two synthetic stores.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { GET as recountCron } from "@/app/api/cron/recount/route";
import { LEGACY_SLOT, RECOUNT_VERSION, STATE_KEY, SUM_KEY, recountStep } from "@/lib/data-recount";
import { TAKE_DATA, dataKey } from "@/lib/store-data";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STUCK = "recount-stuck@example.com";
const NEXT = "recount-next@example.com";

async function twoStores() {
  redis.clear();
  for (const [owner, handle] of [[STUCK, "recount-stuck"], [NEXT, "recount-next"]]) {
    await claimHandle(owner, handle, handle, "");
    await ensureStatsId(owner);
  }
  const stuck = (await storeForEmail(STUCK))!;
  const next = (await storeForEmail(NEXT))!;
  redis.run(["HSET", STATE_KEY, "phase", "apply", "cursor", "0", "version", RECOUNT_VERSION]);
  // The stuck store first, as the HSCAN reads it.
  redis.run(["HSET", SUM_KEY, STUCK, 4096]);
  redis.run(["HSET", SUM_KEY, NEXT, 2048]);
  return { stuckKey: dataKey(stuck)!, nextKey: dataKey(next)! };
}

/** Every accounting receipt for the stuck store's room is not exact; the others go through. */
function failingFor(key: string): () => void {
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => (commands[0][0] === "EVAL" && commands[0][1] === TAKE_DATA && (commands[0] as unknown[]).includes(key) ? [] : pipeline(commands));
  return () => { redis.pipeline = pipeline; };
}

test("a store whose receipt stays unconfirmed does not hold back the stores after it", async () => {
  const { stuckKey, nextKey } = await twoStores();
  const restore = failingFor(stuckKey);
  let report: Awaited<ReturnType<typeof recountStep>> | null = null;
  try { report = await recountStep(Date.now() + 5_000); } catch { /* the old way: the run stopped here */ }
  finally { restore(); }
  assert.equal(redis.run(["HGET", nextKey, LEGACY_SLOT]) !== null, true, "the next store's room is set in the same run");
  assert.equal(redis.run(["HGET", SUM_KEY, NEXT]), null, "and its sum is let go");
  assert.equal(redis.run(["HGET", stuckKey, LEGACY_SLOT]), null, "the stuck store's room is not set");
  assert.equal(redis.run(["HGET", SUM_KEY, STUCK]), "4096", "its sum is kept for the next run");
  assert.deepEqual({ done: report?.done, unconfirmed: report?.unconfirmed }, { done: false, unconfirmed: 1 });
});

test("the job says a kept sum: HTTP 500 with the count, never a quiet success", async () => {
  const { stuckKey } = await twoStores();
  const restore = failingFor(stuckKey);
  let status = 0;
  let body: { ok?: boolean; error?: string; unconfirmed?: number; applied?: number } = {};
  try {
    const answer = await recountCron(new NextRequest("https://local.example/api/cron/recount"));
    status = answer.status;
    body = await answer.json();
  } finally { restore(); }
  assert.deepEqual({ status, ok: body.ok, error: body.error, unconfirmed: body.unconfirmed, applied: body.applied }, { status: 500, ok: false, error: "unconfirmed", unconfirmed: 1, applied: 1 });
});

test("once the receipt is confirmed, the kept sum is set and the recount is done", async () => {
  const { stuckKey } = await twoStores();
  const restore = failingFor(stuckKey);
  try { await recountStep(Date.now() + 5_000); } catch { /* the old way */ } finally { restore(); }
  const report = await recountStep(Date.now() + 5_000);
  assert.equal(redis.run(["HGET", stuckKey, LEGACY_SLOT]) !== null, true);
  assert.deepEqual({ done: report.done, unconfirmed: report.unconfirmed, pending: redis.run(["HLEN", SUM_KEY]) }, { done: true, unconfirmed: 0, pending: 0 });
});
