/**
 * CX-123 rule 24 proof (Claude 6, sweep of lib/[s-z]*.ts): lib/team.ts reads the team record, the
 * person's store index and the activity log in an unknown reply shape as an empty team, an empty
 * index and an empty log. Each of those decides access, a write or a deletion:
 *   1. teamTwoStepBlocks lets a member in without the owner's required second step;
 *   2. inviteMember writes the team back with no members (every teammate removed);
 *   3. memberStores takes the store off the member's index (SREM) for good;
 *   4. readLog says "never removed before", so a repeated removal does not sweep the API keys again.
 * Synthetic records only, the in-memory Redis stand-in with one reply changed. Each test asserts the
 * exact behavior (refuse, keep, throw) and fails on main today.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inviteMember, memberStores, putMember, readLog, readTeam, setRequireTwoStep, teamTwoStepBlocks } from "@/lib/team";
import { claimHandle, ensureStoreId, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const OWNER = "owner-unknown-team@example.test";
const ANA = "ana-unknown-team@example.test";
const BEN = "ben-unknown-team@example.test";
const indexKey = (email: string) => `nl:team:of:${sha(`nimbus-team-of:${email}`).slice(0, 40)}`;

async function fixture(): Promise<Store> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "unknownteam", "Synthetic team shop", "");
  const store = (await ensureStoreId(OWNER)) ?? (await storeForEmail(OWNER))!;
  assert.ok(store.sid);
  assert.equal(await putMember(store, ANA, "editor"), true);
  assert.equal(await setRequireTwoStep(store, true, OWNER), true);
  return store;
}

/** Answers `shape` for one command on one key; every other command goes to the stand-in. */
async function withReply<T>(command: string, key: string, shape: unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    const replies = await original(commands);
    return commands.map((c, i) => (c[0] === command && c[1] === key ? shape : replies[i]));
  };
  try { return await run(); } finally { redis.pipeline = original; }
}

const SHAPES: [string, unknown][] = [["a number", 7], ["a list", ["x"]], ["an object", { members: [] }], ["broken JSON", "{"]];

test("control: the real records answer as written", async () => {
  const store = await fixture();
  assert.equal(await teamTwoStepBlocks(store, ANA, "editor"), true);
  assert.deepEqual((await readTeam(store.sid)).members.map((m) => m.email), [ANA]);
  assert.deepEqual((await memberStores(ANA)).map((s) => s.store.sid), [store.sid]);
});

for (const [label, shape] of SHAPES) {
  test(`access: a team record read as ${label} never lets a member past the required second step`, async () => {
    const store = await fixture();
    await assert.rejects(() => withReply("GET", `nl:team:${store.sid}`, shape, () => teamTwoStepBlocks(store, ANA, "editor")));
  });

  test(`write: an invitation sent while the team reads as ${label} never removes the members`, async () => {
    const store = await fixture();
    await withReply("GET", `nl:team:${store.sid}`, shape, () => inviteMember(store, BEN, "support", "https://marktmorgen.com")).catch(() => null);
    assert.deepEqual((await readTeam(store.sid)).members.map((m) => m.email), [ANA]);
    assert.equal((await readTeam(store.sid)).requireTwoStep, true);
  });

  test(`deletion: a team record read as ${label} never takes the store off the member's index`, async () => {
    const store = await fixture();
    await withReply("GET", `nl:team:${store.sid}`, shape, () => memberStores(ANA)).catch(() => null);
    const [members] = await redis.pipeline([["SMEMBERS", indexKey(ANA)]]);
    assert.deepEqual(members, [store.sid]);
  });
}

for (const [label, shape] of [["a number", 3], ["an object", { 0: "x" }], ["a string", "rows"]] as [string, unknown][]) {
  test(`removal repeat: the activity log read as ${label} is unknown, never "nobody was removed"`, async () => {
    const store = await fixture();
    await assert.rejects(() => withReply("LRANGE", `nl:team:log:${store.sid}`, shape, () => readLog(store.sid)));
  });
}
