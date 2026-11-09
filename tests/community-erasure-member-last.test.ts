/**
 * Deleting one person from a community (lib/community-erasure.ts), Claude 6 on #2957: the member's own record names
 * their handle and their unsubscribe token, and it is the only place that names them. It is deleted last, after the
 * handle and the token, so when deleting either of those fails, the record is still there for the retry, which then
 * reaches what was left. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];

const community = "0123456789abcdef0123456789abcdef";
const member = "fedcba9876543210fedcba9876543210";
const email = "fictional.member@example.test";
const handle = "fictionalmember";
const token = "0123456789abcdef0123456789abcdef01234567";
const membersKey = `nl:cm:${community}:m`;
const handlesKey = `nl:cm:${community}:h`;
const unsubKey = `nl:cm:unsub:${token}`;

const original = redis.pipeline;
const call = (c: Command[]) => original.call(redis, c);

async function seed() {
  redis.clear();
  // A whole record as lib/community.ts reads it exactly (its own yes or no on a mute and a removal).
  const record = { k: member, e: email, n: "Fictional Member", h: handle, dir: false, mail: true, at: 1, seen: 1, t: token, removed: false, muted: false };
  await call([
    ["HSET", membersKey, member, JSON.stringify(record)],
    ["HSET", handlesKey, handle, member],
    ["SET", unsubKey, JSON.stringify({ id: community, who: member })],
  ]);
}

/** Every command as the stand-in answers it, except one that fails as a provider error would. */
async function failing<T>(fails: (c: Command) => boolean, run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.some(fails)) throw new Error("synthetic provider error");
    return call(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const kept = async () => {
  const [record, owner, unsub] = await call([["HGET", membersKey, member], ["HGET", handlesKey, handle], ["GET", unsubKey]]);
  return { record: record !== null, handle: owner !== null, unsub: unsub !== null };
};

test("healthy: the record, the handle and the token all go in one pass", async () => {
  await seed();
  assert.equal(await forgetCommunityPerson(community, member, email, []), 3);
  assert.deepEqual(await kept(), { record: false, handle: false, unsub: false });
});

test("the handle's delete fails: the record is kept, and the retry deletes the handle and then the record", async () => {
  await seed();
  await assert.rejects(() => failing((c) => c[0] === "HDEL" && c[1] === handlesKey, () => forgetCommunityPerson(community, member, email, [])));
  assert.deepEqual(await kept(), { record: true, handle: true, unsub: false }, "the record still names the handle for the retry");
  await forgetCommunityPerson(community, member, email, []);
  assert.deepEqual(await kept(), { record: false, handle: false, unsub: false });
});

test("the handle's owner read fails: the record is kept for the retry", async () => {
  await seed();
  await assert.rejects(() => failing((c) => c[0] === "HGET" && c[1] === handlesKey, () => forgetCommunityPerson(community, member, email, [])));
  assert.equal((await kept()).record, true);
  await forgetCommunityPerson(community, member, email, []);
  assert.deepEqual(await kept(), { record: false, handle: false, unsub: false });
});

test("the token's delete fails: the record is kept, and the retry deletes the token and then the record", async () => {
  await seed();
  await assert.rejects(() => failing((c) => c[0] === "DEL" && c[1] === unsubKey, () => forgetCommunityPerson(community, member, email, [])));
  assert.deepEqual(await kept(), { record: true, handle: false, unsub: true }, "the record still names the token for the retry");
  await forgetCommunityPerson(community, member, email, []);
  assert.deepEqual(await kept(), { record: false, handle: false, unsub: false });
});

test("the record cannot be read: nothing it names is lost, the record is kept, and the deletion says not done", async () => {
  await seed();
  await assert.rejects(() => failing((c) => c[0] === "HGET" && c[1] === membersKey, () => forgetCommunityPerson(community, member, email, [])));
  assert.deepEqual(await kept(), { record: true, handle: true, unsub: true });
  await forgetCommunityPerson(community, member, email, []);
  assert.deepEqual(await kept(), { record: false, handle: false, unsub: false });
});

test("confirmed absence: no record, nothing to delete, done with 0", async () => {
  redis.clear();
  assert.equal(await forgetCommunityPerson(community, member, email, []), 0);
});
