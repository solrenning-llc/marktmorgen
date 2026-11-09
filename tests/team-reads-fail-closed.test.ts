/**
 * Rule 24, lib/team.ts: a team record that answers in an unknown shape is never "no team".
 *
 * - readTeam / roleIn: unknown throws (UnknownReplyError), never an empty team or "no role" for a paying teammate.
 * - teamTwoStepBlocks: when the team cannot be read, the owner's two-step requirement is taken as on (fail closed).
 * - saveTeam: an unknown read of the record never writes; the requirement and the members stay as they were.
 * - memberStores: a store is taken out of a teammate's index only on confirmed absence, never on an unknown read.
 * - removeMember: a failed index or pipeline-access cleanup is "not finished" (KeysNotSwept), and a repeat finishes it.
 *
 * Synthetic store and Redis only (tests/redis-stub.ts); replies are made malformed on purpose.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { KeysNotSwept, memberStores, putMember, readTeam, removeMember, roleIn, setRequireTwoStep, teamTwoStepBlocks } from "@/lib/team";
import { readPipelineAccess, writePipelineAccess } from "@/lib/pipeline-access";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const OWNER = "team-fail-closed-owner@example.test";
const MATE = "team-fail-closed-mate@example.test";
const OTHER = "team-fail-closed-other@example.test";
const indexKey = (email: string) => `nl:team:of:${createHash("sha256").update(`nimbus-team-of:${email}`).digest("hex").slice(0, 40)}`;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);

/** Runs work with the n-th (from 1) and later GETs of `key` answered by `reply` (0: every GET). */
async function withGet<T>(key: string, reply: unknown, work: () => Promise<T>, from = 1): Promise<T> {
  let seen = 0;
  redis.pipeline = (async (commands: Commands) => {
    const replies = await original(commands);
    return commands.map((c, at) => {
      if (c[0] !== "GET" || c[1] !== key) return replies[at];
      seen += 1;
      return seen >= from ? reply : replies[at];
    });
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const fixture = (async () => {
  redis.clear();
  await claimHandle(OWNER, "teamfailclosed", "Synthetic fail-closed shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  assert.equal(await putMember(store, MATE, "editor"), true);
  assert.equal(await setRequireTwoStep(store, true, OWNER), true);
  const teamKey = `nl:team:${store.sid}`;
  const [saved] = await original([["GET", teamKey]]);
  assert.equal(typeof saved, "string");
  return { store, teamKey, saved: saved as string };
})();

/** The fixture as written, put back before each test, so one test's damage never shows in another. */
async function fresh() {
  const at = await fixture;
  await original([
    ["SET", at.teamKey, at.saved],
    ["DEL", indexKey(MATE), indexKey(OTHER)],
    ["SADD", indexKey(MATE), at.store.sid],
  ]);
  return at;
}

const UNKNOWN: [string, unknown][] = [
  ["a number", 7],
  ["a list", ["x"]],
  ["text that is not JSON", "{"],
  ["JSON that is not a team record", JSON.stringify([1, 2])],
  ["a record without its members list", JSON.stringify({ invites: [] })],
];

test("control: the team as written is read whole", async () => {
  const { store } = await fresh();
  const team = await readTeam(store.sid);
  assert.deepEqual(team.members.map((m) => [m.email, m.role]), [[MATE, "editor"]]);
  assert.equal(team.requireTwoStep, true);
  assert.equal(await roleIn(store, MATE), "editor");
  assert.equal(await roleIn(store, OTHER), null);
  assert.equal(await teamTwoStepBlocks(store, MATE, "editor"), true);
  assert.deepEqual((await memberStores(MATE)).map((m) => m.store.sid), [store.sid]);
});

test("control: no team record is no team, and nobody is held by a requirement nobody set", async () => {
  const { store, teamKey } = await fresh();
  const team = await withGet(teamKey, null, () => readTeam(store.sid));
  assert.deepEqual(team, { members: [], invites: [] });
  assert.equal(await withGet(teamKey, null, () => roleIn(store, MATE)), null);
  assert.equal(await withGet(teamKey, null, () => teamTwoStepBlocks(store, MATE, "editor")), false);
});

for (const [label, reply] of UNKNOWN) {
  test(`a team record read as ${label} is unknown, never an empty team or "no role"`, async () => {
    const { store, teamKey } = await fresh();
    await assert.rejects(() => withGet(teamKey, reply, () => readTeam(store.sid)), UnknownReplyError);
    await assert.rejects(() => withGet(teamKey, reply, () => roleIn(store, MATE)), UnknownReplyError);
  });

  test(`a team record read as ${label} keeps the owner's two-step requirement: the member without a second step is held`, async () => {
    const { store, teamKey } = await fresh();
    assert.equal(await withGet(teamKey, reply, () => teamTwoStepBlocks(store, MATE, "editor")), true);
    // The owner is never held by the requirement, read or not.
    assert.equal(await withGet(teamKey, reply, () => teamTwoStepBlocks(store, OWNER, "owner")), false);
  });

  test(`a team record read as ${label} is never written over: members and requirement stay`, async () => {
    const { store, teamKey, saved } = await fresh();
    // Every GET of the record unknown: the change is refused before writing.
    await assert.rejects(() => withGet(teamKey, reply, () => putMember(store, OTHER, "support")));
    // Only the save's own read of the requirement unknown (the second GET): refused too.
    await assert.rejects(() => withGet(teamKey, reply, () => putMember(store, OTHER, "support"), 2));
    const [now] = await original([["GET", teamKey]]);
    assert.equal(now, saved);
  });

  test(`a team record read as ${label} never takes the store out of the teammate's index`, async () => {
    const { store, teamKey } = await fresh();
    await withGet(teamKey, reply, () => memberStores(MATE)).catch(() => null);
    assert.deepEqual(await original([["SMEMBERS", indexKey(MATE)]]), [[store.sid]]);
    assert.deepEqual((await memberStores(MATE)).map((m) => m.store.sid), [store.sid]);
  });
}

test("a store record read in an unknown shape never takes the store out of the teammate's index", async () => {
  const { store } = await fresh();
  const listed = await withGet(`nl:store:id:${store.sid}`, 7, () => memberStores(MATE));
  assert.deepEqual(listed, []);
  assert.deepEqual(await original([["SMEMBERS", indexKey(MATE)]]), [[store.sid]]);
  assert.deepEqual((await memberStores(MATE)).map((m) => m.store.sid), [store.sid]);
});

test("a teammate's index read in an unknown shape is unknown, never 'on no team'", async () => {
  await fresh();
  redis.pipeline = (async (commands: Commands) => (commands.some((c) => c[0] === "SMEMBERS") ? commands.map(() => 7) : original(commands))) as typeof redis.pipeline;
  try {
    await assert.rejects(() => memberStores(MATE), UnknownReplyError);
  } finally {
    redis.pipeline = original;
  }
});

test("control: confirmed absence still prunes the index (record without them, or no record at all)", async () => {
  const { store } = await fresh();
  const ghost = "0".repeat(32);
  await original([["SADD", indexKey(MATE), ghost]]);
  assert.deepEqual((await memberStores(MATE)).map((m) => m.store.sid), [store.sid]);
  assert.deepEqual(await original([["SMEMBERS", indexKey(MATE)]]), [[store.sid]]);
});

test("a teammate taken off whose index or pipeline access could not be cleaned is 'not finished', and a repeat finishes it", async () => {
  const { store } = await fresh();
  assert.equal(await putMember(store, OTHER, "support"), true);
  await writePipelineAccess(store.statsId!, OTHER, { sales0: "none" }, store);
  redis.pipeline = (async (commands: Commands) => {
    if (commands.some((c) => c[0] === "HDEL" && String(c[1]).startsWith("nl:crm:pacc:"))) throw new Error("stand-in failure");
    if (commands.some((c) => c[0] === "SREM" && c[1] === indexKey(OTHER))) throw new Error("stand-in failure");
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    await assert.rejects(() => removeMember(store, OTHER), KeysNotSwept);
  } finally {
    redis.pipeline = original;
  }
  assert.equal((await readTeam(store.sid)).members.some((m) => m.email === OTHER), false);
  // The repeat (the route reads it from the log) cleans what was left.
  assert.equal(await removeMember(store, OTHER, { repeat: true }), false);
  assert.deepEqual(await readPipelineAccess(store.statsId, OTHER), {});
  assert.deepEqual(await original([["SMEMBERS", indexKey(OTHER)]]), [[]]);
});
