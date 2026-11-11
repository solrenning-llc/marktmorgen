/**
 * A page's save keeps what it replaces only from an exact read (lib/sales-page-store.ts, writePage; CX-123 rule 24).
 *
 * Before: the page's GET answered cut short or of another shape read as "no page before", so the page as it was went
 * into no version (no undo in the studio) while the SET wrote over it. Now the three reads are exact: anything else
 * throws before the room is taken and before anything is written; the creator saves again and loses nothing.
 *
 * Synthetic store and product ids only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readPage, readVersions, writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const STATS = "c".repeat(32);
const PRODUCT = "prod_versions";
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const page = (title: string) => ({ ...parsePage({}), seoTitle: title });

for (const [label, reply] of [
  ["no reply", []],
  ["the page as a number", [7, 0, null]],
  ["a count that is text", [null, "x", null]],
  ["one reply short", [null, 0]],
] as [string, unknown[]][]) {
  test(`the page read as ${label}: nothing is written over it`, async () => {
    redis.clear();
    await writePage(STATS, PRODUCT, page("First"), ROOM);
    const firstVersions = (await readVersions(STATS, PRODUCT)).length;
    redis.pipeline = (async (b: Batch) => (b.length === 3 && b[0][0] === "GET" && b[1][0] === "LLEN" ? reply : pipeline(b))) as typeof redis.pipeline;
    let threw = false;
    try {
      await writePage(STATS, PRODUCT, page("Second"), ROOM);
    } catch {
      threw = true;
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal(threw, true, "an unknown read is not \"no page before\"");
    assert.equal((await readPage(STATS, PRODUCT)).seoTitle, "First");
    assert.equal((await readVersions(STATS, PRODUCT)).length, firstVersions);
  });
}

test("read exactly: the page replaced becomes a version", async () => {
  redis.clear();
  await writePage(STATS, PRODUCT, page("First"), ROOM);
  await writePage(STATS, PRODUCT, page("Second"), ROOM);
  assert.equal((await readPage(STATS, PRODUCT)).seoTitle, "Second");
  const versions = await readVersions(STATS, PRODUCT);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].page.seoTitle, "First");
});
