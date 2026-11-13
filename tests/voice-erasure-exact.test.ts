/**
 * Issue #4382 (erasure, Codex L): forgetVoicePerson took `Number(gone) || 0` from the second DEL and never read the
 * first, so a missing, short or off-shape reply read as a confirmed zero and the erasure reported this module
 * done, while a monthly summary could keep up to three of the erased person's review texts as examples. Now both
 * DEL counts are read exactly, within what each command could delete; anything else throws UnknownReplyError.
 *
 * Synthetic in-memory Redis only.
 */
import { forgetVoicePerson, keptMonths } from "@/lib/customer-voice";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const statsId = "a".repeat(32);
const now = Date.now();
const months = keptMonths(now);
const lock = `nl:voice:lock:${statsId}`;

async function run(reply: unknown[] | null): Promise<string> {
  redis.clear();
  await redis.pipeline([["SET", `nl:voice:${statsId}:${months[0]}`, JSON.stringify({ month: months[0], themes: [{ examples: ["words that must leave"] }] })], ["SET", lock, "reader-token"]]);
  const original = redis.pipeline.bind(redis);
  if (reply) redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === "DEL" && commands[0]?.[1] === lock ? reply : original(commands))) as typeof redis.pipeline;
  try {
    return `resolved ${await forgetVoicePerson(statsId, now)}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "rejected" : `other ${String(error)}`;
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Control: a confirmed erasure answers how many summaries went");
  is("the lock and one summary deleted", await run(null), "resolved 1");

  part("Rule 24: both DEL counts read exactly, within what each could delete");
  is("only the lock's reply", await run([1]), "rejected");
  is("no reply", await run([]), "rejected");
  is("the summaries' count not a number", await run([1, "1"]), "rejected");
  is("the lock's count not a number", await run(["OK", 1]), "rejected");
  is("the lock's count past one key", await run([2, 1]), "rejected");
  is(`the summaries' count past ${months.length} keys`, await run([1, months.length + 1]), "rejected");
  is("three replies", await run([1, 1, 1]), "rejected");
  is("a confirmed nothing there", await run([0, 0]), "resolved 0");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
