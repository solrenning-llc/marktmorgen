/**
 * More of an erasure's deletes, confirmed exactly (CX-123 rule 24): lib/affiliate-bond.ts forgetBondPerson,
 * lib/community-points.ts forgetPointsPerson, lib/calendar-sync.ts forgetFeedCopyPerson and lib/buyer-profile.ts
 * forgetNotesPerson.
 *
 * Before: each read its delete's replies with `Number(x) || 0`, so a reply cut short or of another shape returned 0
 * (or a partial sum) like a delete with nothing to remove, and the person's erasure recorded the part as done. Now
 * anything but exact counts throws; an exact 0 is still 0.
 *
 * Synthetic ids only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { forgetBondPerson } from "@/lib/affiliate-bond";
import { forgetPointsPerson } from "@/lib/community-points";
import { forgetFeedCopyPerson } from "@/lib/calendar-sync";
import { forgetNotesPerson } from "@/lib/buyer-profile";
import { store as redis } from "./redis-stub";

const STATS = "a".repeat(32);
const COMMUNITY = "b".repeat(32);
const MEMBER = "c".repeat(32);
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

const cases: [string, (b: Batch) => boolean, () => Promise<number>][] = [
  ["forgetBondPerson", (b) => b.length === 1 && b[0][0] === "HDEL" && String(b[0][1]).endsWith(":bond"), () => forgetBondPerson(STATS, "person@example.com")],
  ["forgetPointsPerson", (b) => b[0]?.[0] === "ZREM" && String(b[0][1]).endsWith(":pts"), () => forgetPointsPerson(COMMUNITY, MEMBER)],
  ["forgetFeedCopyPerson", (b) => b.length === 1 && b[0][0] === "DEL" && String(b[0][1]).startsWith("nl:cal:out:"), () => forgetFeedCopyPerson(STATS)],
  ["forgetNotesPerson", (b) => b[0]?.[0] === "DEL" && String(b[0][1]).includes(":n:"), () => forgetNotesPerson(STATS, MEMBER)],
];

for (const [name, matches, run] of cases) {
  for (const [label, shape] of [["no reply", () => []], ["text", (b: Batch) => b.map(() => "1")], ["one reply too many", (b: Batch) => [...b.map(() => 1), 1]]] as [string, (b: Batch) => unknown[]][]) {
    test(`${name}: a delete answered as ${label} is not done`, async () => {
      redis.clear();
      redis.pipeline = (async (b: Batch) => (matches(b) ? shape(b) : pipeline(b))) as typeof redis.pipeline;
      try {
        await assert.rejects(run());
      } finally {
        redis.pipeline = pipeline;
      }
    });
  }
  test(`${name}: nothing there is an exact 0`, async () => {
    redis.clear();
    assert.equal(await run(), 0);
  });
}
