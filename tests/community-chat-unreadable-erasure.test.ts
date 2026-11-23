/**
 * A kept community chat row that does not read is never taken for another person's (#5010 row 107, Codex
 * L-20261119-1042). forgetChatPerson parsed each row of the room and compared its author; a row that failed JSON.parse
 * answered "not theirs", so a truncated row still holding the member's id and private text stayed in the room while
 * the erasure deleted the member's cooldown and reported the step done. Now a row that is not an object with a text
 * author makes the scope unknown: UnknownReplyError before anything is deleted, the row and the cooldown kept, and the
 * erasure incomplete, so it is retried. Readable rows are sorted as before. Synthetic, in-memory Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { forgetChatPerson } from "@/lib/community-chat";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const OTHER = "b".repeat(32);
const ROOM = `nl:cm:${COMMUNITY}:ch`;
const SPOKE = (who: string) => `nl:cm:${COMMUNITY}:chs:${who}`;
const mine = JSON.stringify({ i: 1, a: MEMBER, text: "Mine", at: 100 });
const theirs = JSON.stringify({ i: 2, a: OTHER, text: "Theirs", at: 101 });

for (const [label, row] of [
  ["a truncated row holding the member's id and private text", `{"i":3,"a":"${MEMBER}","text":"Private`],
  ["a row that is a number", "5"],
  ["a row that is null", "null"],
  ["a row that is an array", `["${MEMBER}"]`],
  ["a row whose author is not text", JSON.stringify({ i: 4, a: 7, text: "x", at: 102 })],
  ["a row with no author", JSON.stringify({ i: 5, text: "x", at: 103 })],
  // Claude 2 main's LEVE on #5199 (7089084006): JSON.parse keeps only the last of a repeated key, so a damaged row
  // naming the member first and someone else last would read as someone else's and keep the member's text.
  ["a row whose author key is repeated", `{"i":6,"a":"${MEMBER}","text":"Private","at":104,"a":"${OTHER}"}`],
] as [string, string][]) {
  test(`${label}: the erasure is not done, and nothing is deleted`, async () => {
    redis.clear();
    redis.run(["ZADD", ROOM, 100, mine, 101, theirs, 102, row]);
    redis.run(["SET", SPOKE(MEMBER), "1"]);
    await assert.rejects(forgetChatPerson(COMMUNITY, MEMBER), UnknownReplyError);
    assert.notEqual(redis.run(["ZSCORE", ROOM, row]), null, "the row that does not read stays for a repair and a retry");
    assert.notEqual(redis.run(["ZSCORE", ROOM, mine]), null, "nothing of theirs is deleted on a guess");
    assert.equal(redis.run(["EXISTS", SPOKE(MEMBER)]), 1, "the cooldown stays for the retry");
  });
}

test("a room whose rows all read is erased as before: their rows go, another member's stay", async () => {
  redis.clear();
  redis.run(["ZADD", ROOM, 100, mine, 101, theirs]);
  redis.run(["SET", SPOKE(MEMBER), "1"]);
  assert.equal(await forgetChatPerson(COMMUNITY, MEMBER), 1);
  assert.deepEqual(redis.run(["ZRANGEBYSCORE", ROOM, "-inf", "+inf"]), [theirs]);
  assert.equal(redis.run(["EXISTS", SPOKE(MEMBER)]), 0);
});

test("an exact empty room is still nothing to erase", async () => {
  redis.clear();
  assert.equal(await forgetChatPerson(COMMUNITY, MEMBER), 0);
});
