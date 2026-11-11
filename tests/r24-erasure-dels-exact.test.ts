/**
 * An erasure's deletes are confirmed, never taken as done on a reply that is not known (CX-123 rule 24):
 * lib/customer-voice.ts forgetVoicePerson, lib/chat-grant.ts forgetGrantPerson and the member's trace in
 * lib/community-erasure.ts forgetCommunityPerson.
 *
 * Before: each read its DEL's reply with `Number(x) || 0`, so a reply cut short or of another shape returned 0 like
 * a delete with nothing to remove, and the person's erasure recorded the part as done (the month's summaries that
 * quote their reviews could stay). Now each count is read exactly and anything else throws; the erasure marks the
 * part failed. An exact 0 (nothing there) is still 0.
 *
 * Synthetic ids only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { forgetVoicePerson } from "@/lib/customer-voice";
import { forgetGrantPerson } from "@/lib/chat-grant";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { store as redis } from "./redis-stub";

const STATS = "d".repeat(32);
const COMMUNITY = "e".repeat(32);
const WHO = "f".repeat(16);
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

const cases: [string, (b: Batch) => boolean, () => Promise<number>][] = [
  ["forgetVoicePerson", (b) => b.some((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:voice:")), () => forgetVoicePerson(STATS)],
  ["forgetGrantPerson", (b) => b.length === 1 && b[0][0] === "DEL" && String(b[0][1]).includes(":rg:"), () => forgetGrantPerson(COMMUNITY, WHO)],
  ["the community trace", (b) => b.length === 1 && b[0][0] === "DEL" && String(b[0][1]).includes(":tr:"), () => forgetCommunityPerson(COMMUNITY, WHO, "person@example.com", [])],
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
}

test("exact replies: nothing there is 0, a delete is counted", async () => {
  redis.clear();
  assert.equal(await forgetVoicePerson(STATS), 0);
  assert.equal(await forgetGrantPerson(COMMUNITY, WHO), 0);
  await pipeline([["SET", `nl:cm:${COMMUNITY}:rg:${WHO}`, "x"]]);
  assert.equal(await forgetGrantPerson(COMMUNITY, WHO), 1);
});
