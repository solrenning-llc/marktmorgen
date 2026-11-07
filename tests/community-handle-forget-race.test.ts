/**
 * forgetHandle (lib/community-mentions.ts) lets go of a deleted member's
 * handle only if it is still theirs. Read and delete in two trips leave a gap:
 * when the handle is given back and another member takes it between the read
 * and the delete, the delete takes the NEW member's handle, and @ that names
 * them stops leading anywhere (CX-123 rule 24: what decides a deletion is
 * read where the deletion happens).
 *
 * Runs the real code against the in-memory Redis (tests/redis-stub.ts),
 * synthetic ids only, no provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimHandle, forgetHandle } from "@/lib/community-mentions";
import { store } from "./redis-stub";

const COMMUNITY = "handle-forget-race";
const MEMBER = "e5e5e5e5e5e5";
const OTHER = "f6f6f6f6f6f6";
const HANDLES = `nl:cm:${COMMUNITY}:h`;
const HANDLE = "maria-synthetic";

type Batch = (string | number)[][];

/** Runs `between` once, right after the first read of the handle's owner was answered. */
async function withWriteAfterRead(between: () => Promise<void>, run: () => Promise<void>): Promise<boolean> {
  const original: typeof store.pipeline = store.pipeline.bind(store);
  let done = false;
  store.pipeline = async (batch: Batch) => {
    const replies = await original(batch);
    if (!done && batch.some((c) => c[0] === "HGET" && c[1] === HANDLES && c[2] === HANDLE)) {
      done = true;
      store.pipeline = original;
      await between();
    }
    return replies;
  };
  try {
    await run();
  } finally {
    store.pipeline = original;
  }
  return done;
}

const owner = async () => (await store.pipeline([["HGET", HANDLES, HANDLE]]))[0];

test("forgetHandle: a handle another member took between the read and the delete is theirs, and stays", async () => {
  store.clear();
  assert.equal(await claimHandle(COMMUNITY, MEMBER, "Maria Synthetic", ""), HANDLE);
  let gone = -1;
  const interleaved = await withWriteAfterRead(async () => {
    await store.pipeline([["HDEL", HANDLES, HANDLE]]);
    assert.equal(await claimHandle(COMMUNITY, OTHER, "Maria Synthetic", ""), HANDLE);
  }, async () => {
    gone = await forgetHandle(COMMUNITY, HANDLE, MEMBER);
  });
  assert.ok(interleaved, "the other member's claim ran between the read and the delete");
  assert.equal(await owner(), OTHER, "the new member's handle is never deleted by another member's erasure");
  assert.equal(gone, 0, "nothing of the erased member was deleted, so nothing is counted");
});

test("forgetHandle: a write elsewhere between the read and the delete still lets the member's own handle go", async () => {
  store.clear();
  assert.equal(await claimHandle(COMMUNITY, MEMBER, "Maria Synthetic", ""), HANDLE);
  let gone = -1;
  const interleaved = await withWriteAfterRead(async () => {
    assert.equal(await claimHandle(COMMUNITY, OTHER, "Ana Synthetic", ""), "ana-synthetic");
  }, async () => {
    gone = await forgetHandle(COMMUNITY, HANDLE, MEMBER);
  });
  assert.ok(interleaved);
  assert.equal(gone, 1);
  assert.equal(await owner(), null, "the erased member's handle is gone");
  assert.equal((await store.pipeline([["HGET", HANDLES, "ana-synthetic"]]))[0], OTHER, "the other member's handle stays");
});
