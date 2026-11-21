/**
 * Rule 24 in an affiliate's own record (lib/affiliates.ts, readAffiliate): the HGET is read exactly. Only an exact null
 * is "no such affiliate"; a reply cut short or of another shape throws, never "no such affiliate", which wrote an
 * affiliate's own purchase as somebody else's (isSelf false, a commission paid on it) and dropped the commission of
 * an offer after paying (funnelRate 0). A stored record that does not parse is still no affiliate, as before.
 *
 * Synthetic program only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readAffiliate } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STATS = "statsreadaff1";
const store = { statsId: STATS, sid: "sidreadaff1" } as unknown as Store;
const ID = "aaaaaaaaaaaa";
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

async function seed(): Promise<void> {
  redis.clear();
  await pipeline([["HSET", `nl:aff:${STATS}:people`, ID, JSON.stringify({ id: ID, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })]]);
}

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["an object", [{}]], ["two replies", [null, null]]] as [string, unknown[]][]) {
  test(`read as ${label}: throws, never "no such affiliate"`, async () => {
    await seed();
    redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "HGET" && b[0][1] === `nl:aff:${STATS}:people` ? reply : pipeline(b))) as typeof redis.pipeline;
    let outcome: string;
    try {
      outcome = JSON.stringify(await readAffiliate(store, ID));
    } catch {
      outcome = "threw";
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal(outcome, "threw");
  });
}

test("read exactly: the record, and null for an id with none", async () => {
  await seed();
  assert.equal((await readAffiliate(store, ID))?.email, "sara@example.com");
  assert.equal(await readAffiliate(store, "bbbbbbbbbbbb"), null);
});
