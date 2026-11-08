/** Author-disclosed inherited erasure read/delete race. Same desired invariant on pre-PR main and current head. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mintReviewLink } from "@/lib/review-proof";
import { forgetNoted, noteForErasure } from "@/lib/erasure-index";
import type { Store } from "@/lib/store";
import { store as redis } from "../../../tests/redis-stub";
const stats = "2".repeat(32), email = "synthetic-erasure-read@buyer.example";
const room = { statsId: stats, handle: "read-race3296" } as unknown as Store;
test("inherited MEDIUM: an in-flight erasure must not delete the new index while leaving the new address grant", async () => {
  redis.clear(); const real = redis.pipeline.bind(redis);
  let signalRead!: () => void, release!: () => void;
  const read = new Promise<void>(r => { signalRead = r; });
  const gate = new Promise<void>(r => { release = r; });
  let first = true, key = "", token: string | undefined;
  const batches: (string | number)[][][] = [];
  redis.pipeline = async commands => {
    batches.push(commands);
    for (const c of commands) if (c[0] === "ZADD" && String(c[3]).startsWith("nl:rev:link:")) key = String(c[3]);
    const replies = await real(commands);
    if (first && commands.some(c => c[0] === "SMEMBERS" && String(c[1]).startsWith("nl:erase:ix:"))) {
      first = false; signalRead(); await gate;
    }
    return replies;
  };
  const erasing = forgetNoted(stats, email);
  try { await read; token = await mintReviewLink(room, "pi_synthetic_read3296", email); }
  finally { release(); await erasing; redis.pipeline = real; }
  const index = String(noteForErasure(stats, email, key)[0][1]);
  const [raw, notes, ttl] = await real([["GET", key], ["ZRANGEBYSCORE", index, "-inf", "+inf"], ["TTL", key]]);
  await forgetNoted(stats, email); const [after] = await real([["GET", key]]);
  console.log("Z_INHERITED_READ_RACE", JSON.stringify({ returnedToken: typeof token === "string", grantBytes: typeof raw === "string" ? Buffer.byteLength(raw) : 0, notes, ttl, retainedAfterSecondErasure: typeof after === "string", commands: batches.flat().map(c => c[0]), jsonPipelineBytes: batches.reduce((n,c) => n + Buffer.byteLength(JSON.stringify(c)),0) }));
  assert.equal(after, null, "a completed erasure must not leave an unindexed grant retaining the erased address");
});
