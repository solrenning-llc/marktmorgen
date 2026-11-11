/**
 * The counts an erasure is paid for by (lib/person-erasure.ts, erasureSize), read exactly (rule 24, MR).
 *
 * Before: dealCount, conversationCount, dmCount and roomSize read a reply cut short or of another shape as 0, so the
 * erasure took fewer units than the reads it then made. Now each throws UnknownReplyError (erasurePerson answers
 * "unavailable"), and an exact count is still read as before.
 *
 * Synthetic store and community ids only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dealCount } from "@/lib/crm";
import { conversationCount } from "@/lib/inbox";
import { dmCount } from "@/lib/community-dm";
import { roomSize } from "@/lib/community-chat";
import { store as redis } from "./redis-stub";

const STATS = "a".repeat(32);
const COMMUNITY = "b".repeat(32);
const WHO = "c".repeat(16);
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

const counts: [string, () => Promise<number>, number][] = [
  ["dealCount", () => dealCount(STATS), 1],
  ["conversationCount", () => conversationCount(STATS), 1],
  ["dmCount", () => dmCount(COMMUNITY, WHO), 2],
  ["roomSize", () => roomSize(COMMUNITY), 1],
];

for (const [name, count, commands] of counts) {
  for (const [label, reply] of [
    ["no reply", []],
    ["text", Array(commands).fill("3")],
    ["a negative number", Array(commands).fill(-1)],
    ["one reply too many", Array(commands + 1).fill(2)],
  ] as [string, unknown[]][]) {
    test(`${name}: a reply read as ${label} is unknown, never 0`, async () => {
      redis.clear();
      redis.pipeline = (async (b: Batch) => (b.length >= 1 && /^(HLEN|ZCARD)$/.test(String(b[0][0])) ? reply : pipeline(b))) as typeof redis.pipeline;
      try {
        await assert.rejects(count());
      } finally {
        redis.pipeline = pipeline;
      }
    });
  }

  test(`${name}: an exact count is read as it is`, async () => {
    redis.clear();
    redis.pipeline = (async (b: Batch) => (b.length >= 1 && /^(HLEN|ZCARD)$/.test(String(b[0][0])) ? Array(commands).fill(2) : pipeline(b))) as typeof redis.pipeline;
    try {
      assert.equal(await count(), 2 * commands);
    } finally {
      redis.pipeline = pipeline;
    }
  });
}
