/**
 * Codex L-20261121-0758 (row 20 of #5010, MEDIUM): a person's erasure from a community (lib/community-erasure.ts)
 * left their member key, derived from their address, in the recipient list of every announcement still being sent
 * (nl:cm:mail:<job>:to), for up to sixty days, while the erasure said it was done. Now the erasure reads the
 * community's own sends under way (nl:cm:<community>:sends, at most MAX_SENDS_UNDER_WAY, never the queue of every
 * store) and writes the erased mark over the key where it stands (lib/erasure-lists.ts blankInLists), so the place
 * of everyone after it does not move. A reply in an unknown shape, or more sends than can be under way, refuses the
 * erasure instead of saying it finished. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { ERASED_MARK } from "@/lib/erasure-lists";
import { MAX_SENDS_UNDER_WAY } from "@/lib/community-text";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];

const community = "0123456789abcdef0123456789abcdef";
const elsewhere = "abcdef0123456789abcdef0123456789";
const who = "fedcba9876543210fedcba9876543210";
const next = "1111111111111111111111111111111f";
const email = "fictional.member@example.test";
const job = "a".repeat(24);
const otherJob = "b".repeat(24);
const original = redis.pipeline;
const call = (c: Command[]) => original.call(redis, c);
const sends = (id: string) => `nl:cm:${id}:sends`;
const recipients = (id: string) => `nl:cm:mail:${id}:to`;

async function seed() {
  redis.clear();
  const record = { k: who, e: email, n: "Fictional Member", h: "", dir: false, mail: true, at: 1, seen: 1, removed: false, muted: false };
  const send = (id: string, c: string) => JSON.stringify({ id, community: c, handle: "fictional", post: "f".repeat(12), subject: "Synthetic", body: "Synthetic", total: 2, done: 0, sent: 0, status: "sending", note: "", failures: 0 });
  await call([
    ["HSET", `nl:cm:${community}:m`, who, JSON.stringify(record)],
    ["SET", `nl:cm:mail:${job}`, send(job, community)],
    ["RPUSH", recipients(job), who, next],
    ["SADD", "nl:cm:mailq", job, otherJob],
    ["SADD", sends(community), job],
    // The same person in another store's community, not the one they are deleted from: left as it is.
    ["SET", `nl:cm:mail:${otherJob}`, send(otherJob, elsewhere)],
    ["RPUSH", recipients(otherJob), who],
    ["SADD", sends(elsewhere), otherJob],
  ]);
}

async function answering<T>(reply: (c: Command[]) => unknown[] | undefined, run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => reply(commands) ?? call(commands)) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

test("the erased member's key is written over in the community's sends under way, in its place", async () => {
  await seed();
  await forgetCommunityPerson(community, who, email, []);
  const [left, other] = await call([["LRANGE", recipients(job), 0, -1], ["LRANGE", recipients(otherJob), 0, -1]]);
  assert.deepEqual(left, [ERASED_MARK, next], "the key is gone and the member after it keeps their place");
  assert.deepEqual(other, [who], "another community's send is not this erasure's");
});

test("a read of the sends under way in an unknown shape refuses the erasure", async () => {
  await seed();
  await assert.rejects(answering((c) => (c.length === 1 && c[0][0] === "SMEMBERS" && c[0][1] === sends(community) ? ["not a list"] : undefined),
    () => forgetCommunityPerson(community, who, email, [])));
});

test(`more than ${MAX_SENDS_UNDER_WAY} sends under way refuses the erasure, never a partial pass said finished`, async () => {
  await seed();
  const many = Array.from({ length: MAX_SENDS_UNDER_WAY + 1 }, (_, i) => i.toString(16).padStart(24, "c"));
  await call([["SADD", sends(community), ...many]]);
  await assert.rejects(forgetCommunityPerson(community, who, email, []));
});
