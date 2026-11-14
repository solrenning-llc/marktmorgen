/**
 * Deleting a person is charged to the store's studio allowance before the
 * work, from counts read first (erasureSize, lib/person-erasure.ts). The
 * inbox's count (conversationCount) read ZCARD with `Number(n) || 0`, so an
 * answer in another shape was counted as an inbox with no conversations: the
 * erasure was charged as if it had none to read, though it reads and deletes
 * up to MAX_CONVERSATIONS of them (rule 24; CX-123: a deletion's ceiling uses
 * only exact, known counts). Now an unknown count throws, so the erasure
 * answers "unavailable" before anything is done. Controls: an exact count is
 * still returned, held to MAX_CONVERSATIONS. Synthetic data only.
 */
import { conversationCount } from "@/lib/inbox";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "stats_harbor";

async function main(): Promise<void> {
  redis.clear();
  const real = redis.pipeline.bind(redis);
  const index = redis.keys().length; // nothing yet
  is("empty start", index, 0);

  part("Control: an exact count is returned");
  is("no conversations", await conversationCount(SID), 0);
  const key = await (async () => {
    // Find the index key the module uses, by writing through ZCARD's own command.
    let seen = "";
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands[0]?.[0] === "ZCARD") seen = String(commands[0][1]);
      return real(commands);
    }) as typeof redis.pipeline;
    await conversationCount(SID);
    redis.pipeline = real;
    return seen;
  })();
  for (let i = 0; i < 3; i += 1) redis.run(["ZADD", key, i, `c${i}`]);
  is("three conversations", await conversationCount(SID), 3);

  part("An unknown count is never read as an empty inbox");
  for (const [label, shape] of [
    ["no reply", undefined],
    ["a word", "OK"],
    ["a list", [3]],
    ["a fraction", 1.5],
    ["a negative number", -1],
  ] as [string, unknown][]) {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await real(commands);
      return commands[0]?.[0] === "ZCARD" ? [shape] : replies;
    }) as typeof redis.pipeline;
    const outcome = await conversationCount(SID).then(
      (n) => `counted ${n}`,
      () => "unknown",
    );
    redis.pipeline = real;
    is(`(${label}) unknown, not counted`, outcome, "unknown");
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
