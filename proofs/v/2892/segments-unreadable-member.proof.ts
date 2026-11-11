/**
 * Proof for #2892 (Claude 5, claude5/fix-list-limits), CX-123 rule 24: listSegments now reads HVALS as an exact list
 * of strings, but a member that is a string and not a saved group (parseSegment answers null) is still dropped in
 * silence. saveSegment then decides MAX_SEGMENTS and the id of a name saved again on fewer groups than are kept:
 * with the list full, one member that does not read lets group 21 be written; when the member that does not read is
 * "Group 0", saving "Group 0" writes a second one under a new id. A kept member that does not read is unknown, not
 * absent. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_SEGMENTS, listSegments, saveSegment } from "@/lib/segments";
import type { Store } from "@/lib/store";
import { store as redis } from "../../../tests/redis-stub";

redis.clear();
const shop = { listId: "segproofslist" } as unknown as Store;
const small = { listId: "segproofsmall" } as unknown as Store;
const keyOf = (store: Store) => `nl:mail:segs:${store.listId}`;
const groupsKey = keyOf(shop);
const hlen = async (key = groupsKey) => Number((await redis.pipeline([["HLEN", key]]))[0]);
const named = async (name: string, key = groupsKey) =>
  ((await redis.pipeline([["HVALS", key]]))[0] as string[]).map((raw) => JSON.parse(raw) as { name: string }).filter((g) => g.name.toLowerCase() === name.toLowerCase()).length;

/** HVALS answers the kept groups with the one named `hide` replaced by text that is not a group, while `run` runs. */
async function withUnreadable<T>(hide: string, run: () => Promise<T>, key = groupsKey): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = (await original.call(redis, commands)) as unknown[];
    if (commands.length !== 1 || commands[0][0] !== "HVALS" || commands[0][1] !== key) return replies;
    const values = replies[0] as string[];
    return [values.map((raw) => ((JSON.parse(raw) as { name: string }).name === hide ? "{" : raw))];
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const full = (async () => {
  for (let i = 0; i < MAX_SEGMENTS; i += 1) assert.equal((await saveSegment(shop, { name: `Group ${i}`, narrow: { minSpent: 100 + i } })).ok, true);
  assert.equal(await hlen(), MAX_SEGMENTS);
})();

test("control: with every member read, the full list refuses group 21 and the same name keeps its id", async () => {
  await full;
  assert.deepEqual(await saveSegment(shop, { name: "One more", narrow: { minSpent: 100 } }), { ok: false, reason: "full" });
  assert.equal((await saveSegment(shop, { name: "group 1", narrow: { minSpent: 321 } })).ok, true);
  assert.equal(await named("Group 1"), 1);
  assert.equal(await hlen(), MAX_SEGMENTS);
});

test("a kept member that does not read is unknown: listSegments throws rather than answering fewer groups", async () => {
  await full;
  await withUnreadable("Group 5", () => assert.rejects(() => listSegments(shop.listId)));
});

test("a kept member that does not read never lets group 21 be written", async () => {
  await full;
  const saved = await withUnreadable("Group 5", () => saveSegment(shop, { name: "One more", narrow: { minSpent: 100 } }));
  assert.deepEqual(saved, { ok: false, reason: "unavailable" }, `got ${JSON.stringify(saved).slice(0, 60)}: the list now holds ${await hlen()} groups (MAX_SEGMENTS ${MAX_SEGMENTS})`);
  assert.equal(await hlen(), MAX_SEGMENTS);
});

test("the member of the same name that does not read never lets a second group of that name be written", async () => {
  // A list well under the cap, so only the id is decided on the read.
  for (let i = 0; i < 3; i += 1) assert.equal((await saveSegment(small, { name: `Group ${i}`, narrow: { minSpent: 100 + i } })).ok, true);
  const saved = await withUnreadable("Group 0", () => saveSegment(small, { name: "Group 0", narrow: { minSpent: 999 } }), keyOf(small));
  assert.deepEqual(saved, { ok: false, reason: "unavailable" }, `got ${JSON.stringify(saved).slice(0, 60)}: ${await named("Group 0", keyOf(small))} groups named "Group 0"`);
  assert.equal(await named("Group 0", keyOf(small)), 1);
  assert.equal(await hlen(keyOf(small)), 3);
});

test("confirmed absence: a list with no saved group answers none", async () => {
  assert.deepEqual(await listSegments("segproofsempty"), []);
});
