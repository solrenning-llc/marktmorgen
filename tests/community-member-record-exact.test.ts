/**
 * A community member's own record is reported deleted only on its deletes' exact answers (Claude 7 on #3095, MÉDIO,
 * 6894091794). forgetMemberRecord (lib/community.ts), the community erasure's last step, sent HDEL, ZREM and the rate
 * keys' DEL, ignored their answers and counted the record it had read: a pipeline that came back in another shape (a
 * short list, a missing result) with the record still there was counted as 1, forgetCommunityPerson resolved, and the
 * erasure was said finished with the person's email, name, handle and token kept.
 *
 * Now each answer is read exactly (HDEL and ZREM 0 or 1, the DEL from 0 up to the number of rate keys) and any other
 * throws UnknownReplyError, so the erasure says not finished and the retry deletes the record. The count is the HDEL's.
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts).
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
const dirKey = `nl:cm:${community}:dir`;

const original = redis.pipeline;
const call = (c: Command[]) => original.call(redis, c);

async function seed() {
  redis.clear();
  const record = { k: member, e: email, n: "Fictional Member", h: handle, dir: true, mail: true, at: 1, seen: 1, t: token, removed: false, muted: false };
  await call([
    ["HSET", membersKey, member, JSON.stringify(record)],
    ["HSET", `nl:cm:${community}:h`, handle, member],
    ["SET", `nl:cm:unsub:${token}`, JSON.stringify({ id: community, who: member })],
  ]);
}

const isRecordDelete = (commands: Command[]) => commands.some((c) => c[0] === "HDEL" && c[1] === membersKey && c[2] === member);
const recordKept = async () => (await call([["HGET", membersKey, member]]))[0] !== null;

/** The record's delete pipeline answered `reply`; with `run`, its commands ran first (the delete landed, the answer was lost). */
async function answered<T>(reply: (real: unknown[]) => unknown, run: boolean, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => {
    if (!isRecordDelete(commands)) return call(commands);
    const real = run ? await call(commands) : [];
    return reply(real);
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const SHAPES: [string, (real: unknown[]) => unknown][] = [
  ["an empty list", () => []],
  ["a short list", () => [1, 1]],
  ["a list one too long", () => [1, 1, 0, 0]],
  ["not a list", () => ({ result: [1, 1, 0] })],
  ["HDEL as 2", () => [2, 1, 0]],
  ["HDEL as text", () => ["1", 1, 0]],
  ["HDEL as null", () => [null, 1, 0]],
  ["ZREM as -1", () => [1, -1, 0]],
  ["DEL past the rate keys", () => [1, 1, 99]],
  ["DEL as 1.5", () => [1, 1, 1.5]],
];

for (const [name, reply] of SHAPES) {
  test(`the record's delete answered as ${name}, not applied: never a finished erasure, and the retry deletes it`, async () => {
    await seed();
    await assert.rejects(() => answered(reply, false, () => forgetCommunityPerson(community, member, email, [])), { name: "UnknownReplyError" });
    assert.equal(await recordKept(), true, "the record is still there for the retry");
    assert.equal(await forgetCommunityPerson(community, member, email, []), 1, "the retry counts the record's own HDEL");
    assert.equal(await recordKept(), false);
  });
}

test("the record's delete landed and its answer came back in another shape: still never a finished erasure", async () => {
  await seed();
  await assert.rejects(() => answered(() => [], true, () => forgetCommunityPerson(community, member, email, [])), { name: "UnknownReplyError" });
  assert.equal(await recordKept(), false);
  // The retry finds nothing left of the record, and answers exactly.
  assert.equal(await forgetCommunityPerson(community, member, email, []), 0);
});

test("control: exact answers delete the record, its place in the directory and its rate keys, counting the HDEL", async () => {
  await seed();
  await call([["ZADD", dirKey, 1, member]]);
  assert.equal(await forgetCommunityPerson(community, member, email, []), 3);
  assert.deepEqual([await recordKept(), (await call([["ZSCORE", dirKey, member]]))[0]], [false, null]);
});
