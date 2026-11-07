/**
 * Many string keys read with MGET, in chunks: Upstash bills every command of
 * a pipeline, and an MGET of many keys is one command, where a GET a key is
 * as many. Each chunk is its own trip, sent side by side, so one reply holds
 * at most its chunk's values (the caller picks a chunk that keeps that reply
 * within the size it was reviewed at).
 *
 * Read only when whole: each chunk's reply must be an array of exactly the
 * keys asked, each element text or nothing (a key that is gone, or holds no
 * string, which MGET answers nil). Anything else is an unknown and throws
 * UnreadableMget, never a value taken for absent.
 */
import { redisPipeline } from "@/lib/redis";

/** An MGET reply that was not one text-or-nothing for each key asked. */
export class UnreadableMget extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableMget";
  }
}

/** The MGETs reading `keys` at `perMget` keys each takes; a count or a chunk that is not a number is never priced low. */
export function mgetCommands(keys: number, perMget: number): number {
  if (Number.isNaN(keys) || keys === Number.POSITIVE_INFINITY || !Number.isInteger(perMget) || perMget < 1) return Number.POSITIVE_INFINITY;
  return keys > 0 ? Math.ceil(keys / perMget) : 0;
}

/** The values of `keys`, in order, read `perMget` keys at one MGET; throws UnreadableMget on any reply not whole. */
export async function mgetWhole(keys: string[], perMget: number): Promise<(string | null)[]> {
  if (!Number.isInteger(perMget) || perMget < 1) throw new RangeError("an MGET reads at least one key");
  if (keys.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += perMget) chunks.push(keys.slice(i, i + perMget));
  const replies = await Promise.all(chunks.map((chunk) => redisPipeline([["MGET", ...chunk]])));
  const out: (string | null)[] = [];
  chunks.forEach((chunk, c) => {
    const reply: unknown = replies[c];
    const values: unknown = Array.isArray(reply) && reply.length === 1 ? reply[0] : null;
    if (!Array.isArray(values) || values.length !== chunk.length) {
      throw new UnreadableMget(`an MGET of ${chunk.length} keys was not answered whole`);
    }
    for (const value of values) {
      if (value !== null && typeof value !== "string") throw new UnreadableMget("an MGET answered something other than text or nothing");
      out.push(value);
    }
  });
  return out;
}
