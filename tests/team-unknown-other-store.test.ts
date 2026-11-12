/**
 * Rule 24 in lib/team.ts, its two callers that must not be broken by another store's unreadable team
 * (review of #3198):
 *
 * - An owner who is also on another store's team is never locked out of their own studio because that
 *   other store's team record answers in an unknown shape: memberStores leaves that store out of its
 *   answer (and keeps it in the index), and resolveAccess treats the switcher's remembered store whose
 *   team cannot be read as "not this one", falling back to the person's own store. A store the request
 *   pins still throws: no role is ever granted on an unknown read.
 * - Deleting a store whose team record answers in an unknown shape still forgets the team and its log
 *   (dropTeam), so the store's deletion goes on; the teammates' index entries it could not read are left
 *   for memberStores, which drops them on the confirmed absence that follows.
 *
 * Synthetic stores and Redis only (tests/redis-stub.ts); replies are made malformed on purpose.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { dropTeam, logTeam, memberStores, putMember } from "@/lib/team";
import { resolveAccess } from "@/lib/studio-route";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const OWNER_A = "team-other-store-a@example.test";
const OWNER_B = "team-other-store-b@example.test";
const indexKey = (email: string) => `nl:team:of:${createHash("sha256").update(`nimbus-team-of:${email}`).digest("hex").slice(0, 40)}`;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);

/** Runs work with every GET of `key` answered by `reply`. */
async function withGet<T>(key: string, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await original(commands);
    return commands.map((c, at) => (c[0] === "GET" && c[1] === key ? reply : replies[at]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const fixture = (async () => {
  redis.clear();
  for (const [email, handle] of [[OWNER_A, "teamotherstorea"], [OWNER_B, "teamotherstoreb"]]) {
    await claimHandle(email, handle, "Synthetic shop", "");
    await ensureStatsId(email);
    await ensureStoreId(email);
  }
  const a = (await storeForEmail(OWNER_A))!;
  const b = (await storeForEmail(OWNER_B))!;
  assert.equal(await putMember(b, OWNER_A, "editor"), true);
  const teamB = `nl:team:${b.sid}`;
  const [saved] = await original([["GET", teamB]]);
  assert.equal(typeof saved, "string");
  return { a, b, teamB, saved: saved as string };
})();

async function fresh() {
  const at = await fixture;
  await original([
    ["SET", at.teamB, at.saved],
    ["DEL", indexKey(OWNER_A)],
    ["SADD", indexKey(OWNER_A), at.b.sid],
  ]);
  return at;
}

const UNKNOWN: [string, unknown][] = [
  ["a number", 7],
  ["text that is not JSON", "{"],
  ["a record without its members list", JSON.stringify({ invites: [] })],
];

test("control: A is the owner of A and an editor on B", async () => {
  const { a, b } = await fresh();
  assert.deepEqual((await memberStores(OWNER_A)).map((m) => [m.store.sid, m.role]), [[b.sid, "editor"]]);
  const remembered = await resolveAccess(OWNER_A, { remembered: b.sid }, "member");
  assert.equal(remembered.ok && remembered.access.store.sid, b.sid);
  const own = await resolveAccess(OWNER_A, {}, "member");
  assert.equal(own.ok && own.access.store.sid, a.sid);
});

for (const [label, reply] of UNKNOWN) {
  test(`another store's team read as ${label} leaves that store out of memberStores and keeps it in the index`, async () => {
    const { b, teamB } = await fresh();
    assert.deepEqual(await withGet(teamB, reply, () => memberStores(OWNER_A)), []);
    assert.deepEqual(await original([["SMEMBERS", indexKey(OWNER_A)]]), [[b.sid]]);
    assert.deepEqual((await memberStores(OWNER_A)).map((m) => m.store.sid), [b.sid]);
  });

  test(`a remembered store whose team reads as ${label} falls back to the person's own store`, async () => {
    const { a, b, teamB } = await fresh();
    const answer = await withGet(teamB, reply, () => resolveAccess(OWNER_A, { remembered: b.sid }, "member"));
    assert.equal(answer.ok, true);
    assert.equal(answer.ok && answer.access.store.sid, a.sid);
    assert.equal(answer.ok && answer.access.role, "owner");
  });

  test(`a pinned store whose team reads as ${label} still throws: no role on an unknown read`, async () => {
    const { b, teamB } = await fresh();
    await assert.rejects(() => withGet(teamB, reply, () => resolveAccess(OWNER_A, { pinned: b.sid }, "member")), UnknownReplyError);
  });

  test(`deleting a store whose team reads as ${label} still forgets the team and its log`, async () => {
    const { b, teamB } = await fresh();
    await logTeam(b.sid, { who: OWNER_B, role: "owner", what: "Synthetic entry" });
    await withGet(teamB, reply, () => dropTeam(b));
    assert.deepEqual(await original([["EXISTS", teamB], ["EXISTS", `nl:team:log:${b.sid}`]]), [0, 0]);
    // The teammate's index entry it could not read is dropped on the confirmed absence that follows.
    assert.deepEqual(await memberStores(OWNER_A), []);
    assert.deepEqual(await original([["SMEMBERS", indexKey(OWNER_A)]]), [[]]);
  });
}

test("control: deleting a store with a readable team takes it out of each teammate's index at once", async () => {
  const { b, teamB } = await fresh();
  await dropTeam(b);
  assert.deepEqual(await original([["EXISTS", teamB], ["SMEMBERS", indexKey(OWNER_A)]]), [0, []]);
});
