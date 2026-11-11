/**
 * Taking one person out of the lists an email is sent down (added 17 October
 * 2026, for lib/person-erasure.ts).
 *
 * A broadcast or a launch email fixes who it goes to when it starts, as a
 * list, and walks it by position. Taking an address out would move everyone
 * after it up one place and the walk would skip somebody, so the address is
 * written over where it stands instead, with a mark no address can be: the
 * walk passes over it as over anyone it may no longer write to.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

/** What stands where a deleted person stood. Not an address, not a member key. */
export const ERASED_MARK = "-";

/** On the Redis side, so no list travels: KEYS the lists, ARGV[1] what to write over, ARGV[2] the mark. Answers how many places. */
export const BLANK_IN_LISTS = `-- marktmorgen:list-blank:v1
local n = 0
for k = 1, #KEYS do
  local items = redis.call("LRANGE", KEYS[k], 0, -1)
  for i, value in ipairs(items) do
    if value == ARGV[1] then
      redis.call("LSET", KEYS[k], i - 1, ARGV[2])
      n = n + 1
    end
  end
end
return n`;

/** Writes over every place this value holds in these lists. */
export async function blankInLists(keys: string[], value: string): Promise<number> {
  if (!keys.length || !value || !isRedisConfigured()) return 0;
  const reply = await redisPipeline([["EVAL", BLANK_IN_LISTS, keys.length, ...keys, value, ERASED_MARK]]);
  if (!Array.isArray(reply) || reply.length !== 1 || !Object.hasOwn(reply, 0) ||
      typeof reply[0] !== "number" || !Number.isSafeInteger(reply[0]) || reply[0] < 0) {
    // A lost receipt may still mean the script ran. Do not replay it or let
    // the caller certify completion while this part remains unconfirmed.
    throw new Error("This deletion could not be confirmed. Try again.");
  }
  return reply[0];
}
