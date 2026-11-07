/**
 * claimHandle (lib/community-mentions.ts) gives up the handle a member had
 * when they take a new one. The handle they had is read from their record,
 * earlier and elsewhere: by the time it is given up, a second save of the same
 * member (two tabs, a double submit) may already have given it back and
 * another member may have taken it. Deleting it without asking whose it is
 * then takes the OTHER member's handle, so @ that names them leads nowhere,
 * and the next one to claim it is mentioned in their place (CX-123 rule 30,
 * the same pattern as forgetHandle in tests/community-handle-forget-race.test.ts).
 *
 * Runs the real code against the in-memory Redis (tests/redis-stub.ts),
 * synthetic ids only, no provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimHandle } from "@/lib/community-mentions";
import { store } from "./redis-stub";

const COMMUNITY = "handle-claim-race";
const MEMBER = "a1a1a1a1a1a1";
const OTHER = "b2b2b2b2b2b2";
const HANDLES = `nl:cm:${COMMUNITY}:h`;
const HAD = "maria-synthetic";

type Batch = (string | number)[][];

/** Runs `between` once, right after the new handle was taken and before the old one is given up. */
async function withWriteAfterClaim(taken: string, between: () => Promise<void>, run: () => Promise<void>): Promise<boolean> {
  const original: typeof store.pipeline = store.pipeline.bind(store);
  let done = false;
  store.pipeline = async (batch: Batch) => {
    const replies = await original(batch);
    if (!done && batch.some((c) => c[0] === "HSETNX" && c[1] === HANDLES && c[2] === taken)) {
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

const ownerOf = async (handle: string) => (await store.pipeline([["HGET", HANDLES, handle]]))[0];

/** The member's other save already gave the old handle back, and another member took it. */
const otherTakesIt = async () => {
  await store.pipeline([["HDEL", HANDLES, HAD]]);
  assert.equal(await claimHandle(COMMUNITY, OTHER, "Maria Synthetic", ""), HAD);
};

test("claimHandle: a handle another member took between the claim and the release is theirs, and stays", async () => {
  store.clear();
  assert.equal(await claimHandle(COMMUNITY, MEMBER, "Maria Synthetic", ""), HAD);
  let got = "";
  const interleaved = await withWriteAfterClaim("bea-synthetic", otherTakesIt, async () => {
    got = await claimHandle(COMMUNITY, MEMBER, "Bea Synthetic", HAD);
  });
  assert.ok(interleaved, "the other member's claim ran between the new claim and the release");
  assert.equal(got, "bea-synthetic");
  assert.equal(await ownerOf("bea-synthetic"), MEMBER);
  assert.equal(await ownerOf(HAD), OTHER, "the other member's handle is never given up by this member's rename");
});

test("claimHandle: a name that gives no handle never gives up a handle that is another member's now", async () => {
  store.clear();
  // The record still says HAD; another save gave it back and another member took it.
  assert.equal(await claimHandle(COMMUNITY, OTHER, "Maria Synthetic", ""), HAD);
  assert.equal(await claimHandle(COMMUNITY, MEMBER, "!!", HAD), "");
  assert.equal(await ownerOf(HAD), OTHER);
});

test("claimHandle: a handle already theirs never gives up a handle that is another member's now", async () => {
  store.clear();
  assert.equal(await claimHandle(COMMUNITY, MEMBER, "Bea Synthetic", ""), "bea-synthetic");
  assert.equal(await claimHandle(COMMUNITY, OTHER, "Maria Synthetic", ""), HAD);
  // A stale record says HAD; the member already holds "bea-synthetic" from the other save.
  assert.equal(await claimHandle(COMMUNITY, MEMBER, "Bea Synthetic", HAD), "bea-synthetic");
  assert.equal(await ownerOf(HAD), OTHER);
  assert.equal(await ownerOf("bea-synthetic"), MEMBER);
});

test("claimHandle: the healthy rename still gives the old handle back, in the same number of trips", async () => {
  store.clear();
  assert.equal(await claimHandle(COMMUNITY, MEMBER, "Maria Synthetic", ""), HAD);
  const original: typeof store.pipeline = store.pipeline.bind(store);
  let trips = 0;
  store.pipeline = async (batch: Batch) => {
    trips += 1;
    return original(batch);
  };
  try {
    assert.equal(await claimHandle(COMMUNITY, MEMBER, "Bea Synthetic", HAD), "bea-synthetic");
  } finally {
    store.pipeline = original;
  }
  assert.equal(trips, 2, "one claim, one release");
  assert.equal(await ownerOf(HAD), null);
  assert.equal(await ownerOf("bea-synthetic"), MEMBER);
  // A name that gives no handle gives the one they hold back.
  assert.equal(await claimHandle(COMMUNITY, MEMBER, "!!", "bea-synthetic"), "");
  assert.equal(await ownerOf("bea-synthetic"), null);
});

test("claimHandle: an unknown reply to the release is refused, never read as done", async () => {
  store.clear();
  assert.equal(await claimHandle(COMMUNITY, MEMBER, "Maria Synthetic", ""), HAD);
  const original: typeof store.pipeline = store.pipeline.bind(store);
  store.pipeline = async (batch: Batch) => {
    if (batch.some((c) => c[0] === "EVAL" || (c[0] === "HDEL" && c[1] === HANDLES))) return ["OK"];
    return original(batch);
  };
  try {
    await assert.rejects(claimHandle(COMMUNITY, MEMBER, "Bea Synthetic", HAD));
  } finally {
    store.pipeline = original;
  }
  // Nothing was given up on an unknown reply; a later save heals it.
  assert.equal(await ownerOf(HAD), MEMBER);
  assert.equal(await claimHandle(COMMUNITY, MEMBER, "Bea Synthetic", HAD), "bea-synthetic");
  assert.equal(await ownerOf(HAD), null);
});
