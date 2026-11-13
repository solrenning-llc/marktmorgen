/**
 * Many string keys read with MGET, in lots: Upstash bills every command of a
 * pipeline, and an MGET of many keys is one command, where a GET a key is as
 * many. Each lot is its own trip, sent MGET_CONCURRENCY at a time, so one
 * reply holds at most its lot's values (the caller picks a lot that keeps
 * that reply within MGET_REPLY_BYTES at the most a value under its keys can
 * be written at; review of #3079, Codex Z M1, applied to the shared readers
 * of #3545, 11 November 2026).
 *
 * Read only when whole (CX-123 rule 24): each lot's reply must be a list of
 * exactly the keys asked, each value text or nothing (a key that is gone, or
 * holds no string, which MGET answers nil), read from its own data slots
 * (lib/redis-reply.ts). Anything else is an unknown and throws UnreadableMget,
 * an UnknownReplyError, never a value taken for absent.
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, listSlots, repliesFor } from "@/lib/redis-reply";

/**
 * The most one MGET's reply may weigh, as the REST answer's JSON: 1 MiB. A
 * caller sizes its lot from the most a value under its keys can be written
 * at (mgetLotFor), never from the bytes a reading is priced at.
 */
export const MGET_REPLY_BYTES = 1_048_576;
/**
 * How much a stored value can grow in the REST answer: a string of quote
 * characters (or backslashes) is escaped to twice its bytes. A JSON text
 * written with JSON.stringify holds no raw control character, which would
 * escape to six.
 */
export const REPLY_ESCAPE_FACTOR = 2;
/**
 * The most MGET trips mgetWhole has in flight at once. With lots sized from
 * the written cap a reading may take a thousand trips (a calendar feed's
 * making, 2 product records a trip); sent side by side they would open a
 * thousand requests to the database together. They go in waves of this many.
 */
export const MGET_CONCURRENCY = 16;

/** An MGET (or GET) reply that was not one text-or-nothing for each key asked: an unknown (rule 24). */
export class UnreadableMget extends UnknownReplyError {
  constructor(message: string) {
    super("an MGET");
    this.message = message;
    this.name = "UnreadableMget";
  }
}

/** The keys one MGET may read when a value under them can be written at up to `valueBytes`: at least one. */
export function mgetLotFor(valueBytes: number): number {
  return Math.max(1, Math.floor(MGET_REPLY_BYTES / (REPLY_ESCAPE_FACTOR * valueBytes)));
}

/** The MGETs reading `keys` at `perMget` keys each takes; a count or a lot that is not a number is never priced low. */
export function mgetCommands(keys: number, perMget: number): number {
  if (Number.isNaN(keys) || keys === Number.POSITIVE_INFINITY || !Number.isInteger(perMget) || perMget < 1) return Number.POSITIVE_INFINITY;
  return keys > 0 ? Math.ceil(keys / perMget) : 0;
}

/** The values of `keys`, in order, read `perMget` keys at one MGET, a trip each; throws UnreadableMget on any reply not whole. */
export async function mgetWhole(keys: string[], perMget: number): Promise<(string | null)[]> {
  if (!Number.isInteger(perMget) || perMget < 1) throw new RangeError("an MGET reads at least one key");
  if (keys.length === 0) return [];
  const lots: string[][] = [];
  for (let i = 0; i < keys.length; i += perMget) lots.push(keys.slice(i, i + perMget));
  const out: (string | null)[] = [];
  for (let i = 0; i < lots.length; i += MGET_CONCURRENCY) {
    const wave = lots.slice(i, i + MGET_CONCURRENCY);
    const answers = await Promise.all(
      wave.map(async (lot) => {
        const replies = repliesFor(await redisPipeline([["MGET", ...lot]]), 1);
        const values = replies ? listSlots(replies[0]) : null;
        if (!values || values.length !== lot.length) throw new UnreadableMget(`an MGET of ${lot.length} keys was not answered whole`);
        if (!values.every((v) => v === null || typeof v === "string")) throw new UnreadableMget("an MGET answered something other than text or nothing");
        return values as (string | null)[];
      }),
    );
    for (const values of answers) out.push(...values);
  }
  return out;
}

/**
 * The values of `keys`, in order, each read with its own GET, all in one trip:
 * for keys whose values have no byte cap where they are written, so no MGET
 * lot could bound its reply. Read only when whole, as mgetWhole: a reply that
 * is not one text-or-nothing for each key throws UnreadableMget.
 */
export async function getsWhole(keys: string[]): Promise<(string | null)[]> {
  if (keys.length === 0) return [];
  const values = repliesFor(await redisPipeline(keys.map((key) => ["GET", key])), keys.length);
  if (!values) throw new UnreadableMget(`${keys.length} GETs were not answered whole`);
  if (!values.every((v) => v === null || typeof v === "string")) throw new UnreadableMget("a GET answered something other than text or nothing");
  return values as (string | null)[];
}
