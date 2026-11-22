import assert from "node:assert/strict";
import { COPIERS } from "@/lib/person-copy";
import { readInbox } from "@/lib/inbox";
import { listRequests } from "@/lib/payment-request-store";
import { listAgreements } from "@/lib/agreement-store";
import type { ErasureScope } from "@/lib/erasure-rules";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

/**
 * A person's data copy only reads (lib/person-copy.ts: "every reader here is one that changes nothing the person or
 * the store would see"). Three readers it shares with the studio dropped expired ids from their store's index while
 * the copy read through them: the inbox (ZREM, lib/inbox.ts), payment requests (two ZREMs) and agreements (ZREM).
 * Coordinator 71ab, issue #5125, item (2): the copy reads them with `prune: false`, and the studio keeps tidying its
 * index as before.
 */
const statsId = "c".repeat(32);
const sid = "s".repeat(32);
const store = { sid, statsId } as Store;
const scope = { store, sid, statsId, listId: null, email: "ann@example.com", person: "p".repeat(32), learner: "l".repeat(32), courses: [] } as unknown as ErasureScope;
const WRITES = new Set(["ZREM", "ZADD", "DEL", "SET", "HSET", "HDEL", "SREM", "SADD", "EXPIRE", "ZREMRANGEBYSCORE", "EVAL", "INCR", "INCRBY", "LPUSH", "RPUSH", "LTRIM"]);

const inboxIndex = `nl:inbox:${statsId}:all`;
const requestIndex = `nl:payreq:s:${sid}`;
const openRequests = `nl:payreq:o:${sid}`;
const agreementIndex = `nl:agree:s:${sid}`;
const expiredConversation = "abcdefabcdef";
const expiredRequest = "a".repeat(32);
const expiredAgreement = "b".repeat(32);

async function seed(): Promise<void> {
  // Each index names one id whose record has expired: what a reader that prunes would drop.
  await redis.pipeline([
    ["ZADD", inboxIndex, 1, expiredConversation],
    ["ZADD", requestIndex, 1, expiredRequest],
    ["ZADD", openRequests, 1, expiredRequest],
    ["ZADD", agreementIndex, 1, expiredAgreement],
  ]);
}
async function sizes(): Promise<unknown[]> {
  return redis.pipeline([["ZCARD", inboxIndex], ["ZCARD", requestIndex], ["ZCARD", openRequests], ["ZCARD", agreementIndex]]);
}

let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); checks += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
}

async function main() {
  await seed();
  for (const copied of ["lib/inbox.ts", "lib/payment-request-store.ts", "lib/agreement-store.ts"]) {
    await check(`the copy reads ${copied} without writing anything`, async () => {
      const pipeline = redis.pipeline.bind(redis);
      const sent: string[] = [];
      redis.pipeline = async (batch) => { for (const command of batch) sent.push(String(command[0]).toUpperCase()); return pipeline(batch); };
      try {
        const copier = COPIERS[copied];
        assert.ok(copier, `${copied} has a copier`);
        assert.deepEqual(await copier(scope), []);
      } finally {
        redis.pipeline = pipeline;
      }
      assert.deepEqual(sent.filter((c) => WRITES.has(c)), [], `writes sent while copying ${copied}`);
    });
  }
  await check("and every expired id is still in its index after the copy", async () => {
    assert.deepEqual(await sizes(), [1, 1, 1, 1]);
  });

  await check("the studio's readers still tidy their index as before", async () => {
    assert.deepEqual(await readInbox(statsId), []);
    assert.deepEqual(await listRequests(store), []);
    assert.deepEqual(await listAgreements(store), []);
    assert.deepEqual(await sizes(), [0, 0, 0, 0]);
  });

  console.log(process.exitCode ? `${checks} checks passed; some failed.` : `${checks} checks, all passing.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
