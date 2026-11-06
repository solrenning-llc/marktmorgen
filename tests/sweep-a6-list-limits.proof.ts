/**
 * Proof (sweep A6, CX-123 rule 24/30): two studio lists are read with
 * `Array.isArray(raw) ? raw : []`, and the empty list then decides a write.
 *
 *   - lib/short-links.ts addLink: readLinks' HVALS in an unknown shape is "no
 *     links", so link 101 is written past MAX_LINKS, and a second link with a
 *     name already taken is written beside the first (its results then add up);
 *   - lib/segments.ts saveSegment: listSegments' HVALS in an unknown shape is
 *     "no groups", so group 21 is written past MAX_SEGMENTS, and a group saved
 *     again under its own name is written twice instead of replaced.
 *
 * The "defect" tests assert the fail-closed behavior and FAIL ON PURPOSE on
 * main; each "control" passes. Synthetic records and the in-memory Redis only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addLink } from "@/lib/short-links";
import { MAX_LINKS } from "@/lib/short-link-rules";
import { MAX_SEGMENTS, saveSegment } from "@/lib/segments";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

redis.clear();
const mine = { sid: "sweep-a6-sid", statsId: "sweepa6stats" };
const isProduct = () => false;
const shop = { listId: "sweepa6list" } as unknown as Store;

async function withWrong<T>(command: string, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => (commands.length === 1 && commands[0][0] === command ? [] : original.call(redis, commands))) as typeof redis.pipeline;
  try { return await run(); } finally { redis.pipeline = original; }
}
const hlen = async (key: string) => Number((await redis.pipeline([["HLEN", key]]))[0]);

const links = (async () => {
  for (let i = 0; i < MAX_LINKS; i += 1) assert.equal((await addLink(mine, { name: `Post ${i}`, place: "instagram", target: { kind: "store" } }, isProduct, 1_000 + i)).ok, true);
})();

test("control: link 101 is refused when HVALS answers", async () => {
  await links;
  assert.deepEqual(await addLink(mine, { name: "One more", place: "x", target: { kind: "store" } }, isProduct), { ok: false, reason: "full" });
});

test("defect: an HVALS reply missing its slot must not let link 101 be written", async () => {
  await links;
  const added = await withWrong("HVALS", () => addLink(mine, { name: "Post 0", place: "x", target: { kind: "store" } }, isProduct));
  assert.equal(added.ok, false, `expected a refusal; got ok=${added.ok}: the store now holds ${await hlen(`nl:slink:store:${mine.statsId}`)} links (MAX_LINKS ${MAX_LINKS}), two of them named "Post 0"`);
});

const groups = (async () => {
  for (let i = 0; i < MAX_SEGMENTS; i += 1) assert.equal((await saveSegment(shop, { name: `Group ${i}`, narrow: { minSpent: 100 + i } })).ok, true);
})();

test("control: group 21 is refused when HVALS answers", async () => {
  await groups;
  assert.deepEqual(await saveSegment(shop, { name: "One more", narrow: { minSpent: 100 } }), { ok: false, reason: "full" });
});

test("defect: an HVALS reply missing its slot must not let group 21 be written", async () => {
  await groups;
  const saved = await withWrong("HVALS", () => saveSegment(shop, { name: "Group 0", narrow: { minSpent: 999 } }));
  assert.equal(saved.ok, false, `expected a refusal; got ok=${saved.ok}: the list now holds ${await hlen("nl:mail:segs:sweepa6list")} groups (MAX_SEGMENTS ${MAX_SEGMENTS}), two named "Group 0"`);
});
