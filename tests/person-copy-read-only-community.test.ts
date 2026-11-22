import assert from "node:assert/strict";
import { ALSO_COPIERS, COPIERS } from "@/lib/person-copy";
import { heldOf } from "@/lib/community-approval";
import { importTracesOf } from "@/lib/imports";
import type { ErasureScope } from "@/lib/erasure-rules";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

/**
 * A person's data copy only reads (lib/person-copy.ts: "every reader here is one that changes nothing the person or
 * the store would see"). Two more readers it shares with the studio wrote while the copy read through them (issue
 * #5125, item (2); coordinator a823, Claude 4 3Rj): the member's waiting list in a community (heldOf, a ZREM of ids
 * whose item is gone, lib/community-approval.ts) and an import's report past its keeping (importTracesOf, a DEL,
 * lib/imports.ts). The copy reads them with `prune: false`, the same option as the inbox, payment requests and
 * agreements (Claude 4 2Wb, tests/person-copy-read-only.test.ts), and the studio and the erasure keep tidying as
 * before.
 */
const statsId = "c".repeat(32);
const sid = "d".repeat(32);
const communityId = "e".repeat(32);
const learner = "l".repeat(32);
const store = { sid, statsId } as Store;
const scope = { store, sid, statsId, listId: null, email: "ann@example.com", person: "p".repeat(32), learner, communityId, courses: [], productIds: [] } as unknown as ErasureScope;
const WRITES = new Set(["ZREM", "ZADD", "DEL", "UNLINK", "SET", "HSET", "HDEL", "SREM", "SADD", "EXPIRE", "ZREMRANGEBYSCORE", "EVAL", "EVALSHA", "INCR", "INCRBY", "LPUSH", "RPUSH", "LTRIM", "LREM"]);

const waiting = `nl:cm:${communityId}:ap:w:${learner}`;
const goneItem = "f".repeat(12);
const importId = "0123456789abcdef01234567";
const importList = `nl:imports:list:${sid}`;
const importReport = `nl:import:${importId}:errors`;

async function seed(now: number): Promise<void> {
  await redis.pipeline([
    // The member's waiting list names an item whose record is gone: what heldOf drops when it prunes.
    ["ZADD", waiting, Math.floor(now / 1000) - 60, goneItem],
    // An import from long ago, its report of rows not brought in still kept (a report from before the fixed
    // deadline): what importTracesOf deletes when it prunes.
    ["RPUSH", importList, importId],
    ["SET", `nl:import:${importId}`, JSON.stringify({ id: importId, sid, at: 0, file: "old.csv" })],
    ["RPUSH", importReport, JSON.stringify([2, "email", "not an address", "ann@example.com"])],
  ]);
}
async function kept(): Promise<unknown[]> {
  return redis.pipeline([["ZCARD", waiting], ["EXISTS", importReport]]);
}

let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); checks += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
}

async function spy<T>(run: () => Promise<T>): Promise<{ result: T; writes: string[] }> {
  const pipeline = redis.pipeline.bind(redis);
  const writes: string[] = [];
  redis.pipeline = async (batch) => {
    for (const command of batch) if (WRITES.has(String(command[0]).toUpperCase())) writes.push(`${String(command[0]).toUpperCase()} ${String(command[1])}`);
    return pipeline(batch);
  };
  try {
    return { result: await run(), writes };
  } finally {
    redis.pipeline = pipeline;
  }
}

async function main() {
  const now = Date.now();
  await seed(now);

  await check("the copy reads a member's waiting items without dropping the one whose item is gone", async () => {
    const copier = COPIERS["lib/community-erasure.ts"];
    assert.ok(copier, "lib/community-erasure.ts has a copier");
    const { writes } = await spy(() => copier(scope));
    assert.deepEqual(writes.filter((w) => w.includes(":ap:")), [], "writes to the community's approval keys while copying");
  });
  await check("the copy reads the store's imports without deleting a report past its keeping", async () => {
    const copier = ALSO_COPIERS["lib/imports.ts"];
    assert.ok(copier, "lib/imports.ts has a copier");
    const { result, writes } = await spy(() => copier(scope, now));
    assert.deepEqual(writes, [], "writes while copying lib/imports.ts");
    // Past its keeping, the report is not disclosed, as before.
    assert.equal(JSON.stringify(result).includes("not an address"), false);
  });
  await check("and both are still there after the copy", async () => {
    assert.deepEqual(await kept(), [1, 1]);
  });

  await check("the member's own reading and a direct read still tidy as before", async () => {
    assert.deepEqual(await heldOf(communityId, learner), []);
    const traces = await importTracesOf(store, "ann@example.com", now);
    assert.equal(JSON.stringify(traces.records).includes("not an address"), false);
    assert.deepEqual(await kept(), [0, 0]);
  });

  console.log(process.exitCode ? `${checks} checks passed; some failed.` : `${checks} checks, all passing.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
