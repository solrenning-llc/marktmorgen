/**
 * Rule 24 in a community poll (lib/community-polls.ts, vote): the member's earlier vote (HGET) is read exactly before
 * the tally moves. A reply cut short or of another shape throws, and the tally is left as it was, never "no vote yet",
 * which counted the same vote a second time.
 *
 * Synthetic community, post and member only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parsePoll, vote } from "@/lib/community-polls";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const ID = "c0ffee00c0ffee00c0ffee00c0ffee01";
const POST = "post00000001";
const WHO = "member000001";
const poll = parsePoll({ options: ["Rye", "Spelt"], multi: false, ends: 0 })!;
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const tally = async () => (await pipeline([["HGET", `nl:cm:${ID}:pc:${POST}`, "1"]]))[0];

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["an object", [{}]], ["a list", [["1"]]]] as [string, unknown[]][]) {
  test(`the earlier vote read as ${label}: the same vote is never counted twice`, async () => {
    redis.clear();
    assert.equal(await vote(ID, POST, poll, WHO, ["1"], ROOM), true);
    assert.equal(await tally(), "1");
    redis.pipeline = (async (b: Batch) => (b.length === 1 && b[0][0] === "HGET" && b[0][1] === `nl:cm:${ID}:pv:${POST}` ? reply : pipeline(b))) as typeof redis.pipeline;
    try {
      await vote(ID, POST, poll, WHO, ["1"], ROOM).catch(() => "threw");
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal(await tally(), "1", "one vote, counted once");
  });
}

test("read exactly, voting again for the same option changes nothing", async () => {
  redis.clear();
  await vote(ID, POST, poll, WHO, ["1"], ROOM);
  await vote(ID, POST, poll, WHO, ["1"], ROOM);
  assert.equal(await tally(), "1");
});
