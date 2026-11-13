/**
 * Issue #4384 (erasure, Codex L): forgetNotesPerson read only the first slot of its DEL/SREM pipeline as
 * `Number(gone) || 0`, so a missing or off-shape DEL reply read as a confirmed zero and the SREM was never
 * checked: a person's erasure could be reported complete while the team's notes about them, or their place in
 * the index, were still kept. Now both replies are read exactly (two integer counts, 0 or 1); anything else
 * throws UnknownReplyError, so the erasure stays open and is run again.
 *
 * Synthetic in-memory Redis only.
 */
import { forgetNotesPerson } from "@/lib/buyer-profile";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const statsId = "s".repeat(32);
const person = "a".repeat(32);
const notes = `nl:person:${statsId}:n:${person}`;
const who = `nl:person:${statsId}:who`;

async function outcome(reply: unknown[] | null): Promise<string> {
  redis.clear();
  await redis.pipeline([
    ["HSET", notes, "deadbeef", JSON.stringify({ at: 1, by: "team@example.com", text: "private follow-up" })],
    ["SADD", who, person],
  ]);
  const original = redis.pipeline.bind(redis);
  if (reply) redis.pipeline = (async (commands: Commands) => (commands.length === 2 && commands[0]?.[0] === "DEL" && commands[1]?.[0] === "SREM" ? reply : original(commands))) as typeof redis.pipeline;
  try {
    return `resolved ${await forgetNotesPerson(statsId, person)}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "rejected" : `other ${String(error)}`;
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Control: a confirmed erasure answers how many note hashes it deleted");
  is("DEL 1, SREM 1", await outcome(null), "resolved 1");

  part("Rule 24: a reply not exactly two counts of 0 or 1 is unknown, never a confirmed zero");
  is("only the DEL's reply", await outcome([1]), "rejected");
  is("no reply at all", await outcome([]), "rejected");
  is("the DEL's reply not a number", await outcome(["1", 1]), "rejected");
  is("the SREM's reply not a number", await outcome([1, "OK"]), "rejected");
  is("a count out of range", await outcome([2, 1]), "rejected");
  is("a negative count", await outcome([1, -1]), "rejected");
  is("three replies", await outcome([1, 1, 1]), "rejected");
  is("a confirmed nothing there: 0 and 0", await outcome([0, 0]), "resolved 0");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
