/**
 * A count in a window that starts with the first use (C7 TTL hunt): the INCR first, then the window's expiry set only
 * when the key has none (EXPIRE … NX), in one pipeline of two commands.
 *
 * It replaces a SET of "0" with EX and NX followed by an INCR, which an Upstash pipeline does not run as one step: when the key was there for the SET (so it did nothing) and expired before the INCR, the INCR made the key again
 * with no expiry. From then on every SET NX did nothing, the count only grew, and whoever it counts (a connection, an
 * address, a link) was refused for good, the key with its hashed address kept forever. Here a key the INCR makes is
 * given its expiry by the next command whatever happened before, and one that expires between the two is simply gone,
 * the count with it. Still two commands, so no cost line moves (tests/plan-cost-registry.ts).
 */
import { repliesFor } from "@/lib/redis-reply";

type Command = (string | number)[];

/** The two commands of one count of `key` in a window of `seconds`. */
export function windowCount(key: string, seconds: number): Command[] {
  return [
    ["INCR", key],
    ["EXPIRE", key, seconds, "NX"],
  ];
}

/**
 * The same for a count of `n` at once (INCRBY), in the same two commands (Claude 7 on #3369: the SET NX EX + INCRBY
 * pair raced the same way in lib/store-allowance.ts, lib/imports.ts, lib/backup-run.ts and lib/store-readings.ts).
 */
export function windowCountBy(key: string, seconds: number, n: number): Command[] {
  return [
    ["INCRBY", key, n],
    ["EXPIRE", key, seconds, "NX"],
  ];
}

/**
 * The count read from windowCount's two replies, at `at` in a pipeline of `total` commands, only in their exact
 * shape: the INCR's own whole number of at least 1 and the EXPIRE's 0 or 1. Null for anything else, never a count
 * made up (CX-123 rule 24).
 */
export function windowCountOf(replies: unknown, at = 0, total = at + 2): number | null {
  const read = repliesFor(replies, total);
  if (!read) return null;
  const count = read[at];
  const expire = read[at + 1];
  if (!Number.isSafeInteger(count) || (count as number) < 1 || (expire !== 0 && expire !== 1)) return null;
  return count as number;
}
