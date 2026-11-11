/**
 * Rule 24 in the public affiliate directory's index (lib/directory-index.ts, listedStores): each SSCAN page is read
 * exactly. A reply cut short or of another shape throws, so the directory is not built from it, never "the last
 * page" (cursor "0"), which ended the walk early and cached a directory missing the stores after it
 * (lib/affiliate-directory.ts, readDirectory).
 *
 * Synthetic store ids only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { listedStores } from "@/lib/directory-index";
import { store as redis } from "./redis-stub";

type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

for (const [label, reply] of [
  ["no reply", []],
  ["a number", [7]],
  ["only a cursor", [["0"]]],
  ["ids that are not a list", [["0", 7]]],
  ["a cursor that is not text", [[5, ["a"]]]],
  ["an id that is not text", [["0", [1]]]],
] as [string, unknown[]][]) {
  test(`a page read as ${label} throws, never "the last page"`, async () => {
    redis.clear();
    redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "SSCAN" ? reply : pipeline(b))) as typeof redis.pipeline;
    let outcome: string;
    try {
      outcome = JSON.stringify(await listedStores("0", 100));
    } catch {
      outcome = "threw";
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal(outcome, "threw");
  });
}

test("read exactly, an empty index is the last page", async () => {
  redis.clear();
  assert.deepEqual(await listedStores("0", 100), { sids: [], next: "0" });
});
