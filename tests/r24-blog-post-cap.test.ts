/**
 * The blog's cap of MAX_POSTS posts a store, read exactly (lib/store-blog.ts, savePost; rule 24 and MR).
 *
 * Before: the count (HLEN) answered cut short or in another shape was read as 0, so a new post was written past
 * the cap. Now it is unknown: nothing is written and the call throws (the route answers server_error).
 *
 * Synthetic store only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { savePost } from "@/lib/store-blog";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const STATS = "d".repeat(32);
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const input = { title: "A new post", body: "Some words.", product: null, draft: false };

for (const [label, reply] of [["no reply", []], ["text", ["3"]], ["a negative number", [-1]], ["two replies", [1, 1]]] as [string, unknown[]][]) {
  test(`the count read as ${label}: no post is written past an unknown cap`, async () => {
    redis.clear();
    let wrote = false;
    redis.pipeline = (async (b: Batch) => {
      if (b.length === 1 && b[0][0] === "HLEN") return reply;
      if (b.some((c) => c[0] === "HSET" && String(c[1]).startsWith("nl:blog:"))) wrote = true;
      return pipeline(b);
    }) as typeof redis.pipeline;
    try {
      const outcome = await savePost(STATS, null, input, () => "a1b2c3d4e5", ROOM).then(
        (saved) => (saved.ok ? "saved" : saved.reason),
        () => "threw",
      );
      assert.equal(outcome, "threw");
      assert.equal(wrote, false);
    } finally {
      redis.pipeline = pipeline;
    }
  });
}

test("read exactly: a store under the cap saves its post", async () => {
  redis.clear();
  const saved = await savePost(STATS, null, input, () => "a1b2c3d4e5", ROOM);
  assert.equal(saved.ok, true);
});
