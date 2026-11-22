/**
 * A store's notes about people are deleted with the store only on confirmed replies (#4673, found by Codex L).
 * forgetPersonNotes read the people index with `Array.isArray(raw) ? … : []`, so a reply it could not read was
 * "nobody": it deleted only the index and resolved, and every note (the team's address and private text) stayed
 * with nothing left to find it. The index is now read exactly, and every DEL must confirm its own count; anything
 * else throws UnknownReplyError before the index goes. Synthetic store and people; MemoryRedis.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { forgetPersonNotes } from "@/lib/buyer-profile";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const STATS = "statsnotes01";
const WHO = `nl:person:${STATS}:who`;
const PEOPLE = ["a".repeat(32), "b".repeat(32)];
const notes = (p: string) => `nl:person:${STATS}:n:${p}`;
const real = redis.pipeline.bind(redis);

function seed(): void {
  redis.clear();
  redis.pipeline = real;
  for (const p of PEOPLE) {
    redis.run(["SADD", WHO, p]);
    redis.run(["HSET", notes(p), "n1", JSON.stringify({ id: "n1", by: "team@example.com", text: "private", at: 1 })]);
  }
}
const kept = () => [redis.run(["EXISTS", WHO]), ...PEOPLE.map((p) => redis.run(["EXISTS", notes(p)]))];

/** The pipeline, with the reply of the first command matching `when` replaced by `reply`. */
function answer(when: (c: (string | number)[]) => boolean, reply: unknown): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some(when)) return reply;
    return real(commands);
  }) as typeof redis.pipeline;
}

test("a healthy index and deletes: every note and the index go", async () => {
  seed();
  await forgetPersonNotes(STATS);
  assert.deepEqual(kept(), [0, 0, 0]);
});

for (const [label, reply] of [["no reply", []], ["not a list", [42]], ["a list with a number in it", [[PEOPLE[0], 7]]], ["two replies", [[], []]], ["null", null]] as const) {
  test(`an index answered with ${label}: throws, and the index and the notes stay`, async () => {
    seed();
    answer((c) => c[0] === "SMEMBERS", reply);
    await assert.rejects(() => forgetPersonNotes(STATS), UnknownReplyError);
    redis.pipeline = real;
    assert.deepEqual(kept(), [1, 1, 1]);
  });
}

for (const [label, reply] of [["no reply", []], ["text", ["OK"]], ["more than it was sent", [9]], ["a negative count", [-1]]] as const) {
  test(`a notes DEL answered with ${label}: throws before the index goes`, async () => {
    seed();
    answer((c) => c[0] === "DEL" && String(c[1]).includes(":n:"), reply);
    await assert.rejects(() => forgetPersonNotes(STATS), UnknownReplyError);
    redis.pipeline = real;
    assert.equal(redis.run(["EXISTS", WHO]), 1, "the index stays, so a later try finds the notes");
  });
}

test("the index's own DEL answered unknown: throws", async () => {
  seed();
  answer((c) => c[0] === "DEL" && c[1] === WHO, []);
  await assert.rejects(() => forgetPersonNotes(STATS), UnknownReplyError);
});
