/**
 * Marktmorgen Path's leads (13 [D10]): an address counts as one of the
 * store's leads when it uses the confirmation link it was emailed, never when
 * it is only typed in, and once for the store however it confirms.
 *
 *   nl:pathlead:<statsId>:<fingerprint>   string   this address already counted, PATH_LEAD_DAYS
 *
 * Where it is counted, always after the link was used:
 *
 *   - joining the store's list, when that makes the address newly mailable
 *     (app/api/store/join/confirm, `added.joined`);
 *   - a waitlist spot's confirmation (app/api/store/waitlist/confirm, `first`:
 *     a cheap filter that keeps a later press from asking at all);
 *   - a free product's emailed link, the first time it records that address as
 *     having got that product (app/api/store/free/download, `gotProduct`).
 *
 * Exactly once (review 6748073377 of #3431, M1 and L3). Those filters are
 * read and written in separate trips, so two presses at once can both pass
 * them; what decides is the mark, taken with SET NX inside one script with the
 * count (PATH_LEAD_COUNT) and read exactly: a count counts, 0 (already counted:
 * the same address, by any path, any product, written any way) counts nothing,
 * and any other answer counts nothing and throws, so a lead may be missed,
 * never counted twice (rule 24); and a mark is never taken without its count
 * (Codex X5 on #3591). An address counts once in PATH_LEAD_DAYS; after the mark
 * runs out it can count again.
 *
 * The count. "lc" on the store's all-time record (lib/stats.ts,
 * confirmedLeadCommand), one HINCRBY of its own outside the record's capped
 * count, so a record already at LIFE_WRITE_MAX never hides it under "~"
 * (review L4), run in the same script as the mark; its answer is read exactly
 * and an unknown one throws, which the routes log.
 *
 * Privacy. The mark holds a one-way fingerprint of the store's id and the
 * normalized address, never the address. It is noted for the person's
 * deletion (lib/erasure-index.ts) in the same script, before the mark (Codex X8
 * on #3591), so deleting the person deletes it; and an address already deleted
 * from the store writes nothing at all (Codex T on #3591), so a confirmation
 * that resumes after the erasure never makes its mark or note again. A closing
 * store's walk deletes it by the store's id (lib/data-families.ts); otherwise
 * it runs out by itself.
 *
 * Cost (review M2). PATH_LEAD_COMMANDS at the most, as Upstash bills them:
 * the script's EVAL and, inside it, the deletion check, two TYPEs, the note
 * (three) and the mark on every call, and the count once for an address. No public request
 * is taken: the routes that call it take none. Priced with what carried the
 * link (tests/plan-cost-registry.ts: a join or waitlist link is an access
 * email, a free copy's link is an order) and held in
 * tests/path-lead-confirmed.test.ts.
 */
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { noteForErasure } from "@/lib/erasure-index";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { confirmedLeadCommand } from "@/lib/stats";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";

/** How long an address stays counted for a store: under the erasure index's own 401 days, so the note outlives the mark. */
export const PATH_LEAD_DAYS = 400;
/**
 * The most commands one call is billed (Upstash bills each command a script runs beside the EVAL): the EVAL of
 * PATH_LEAD_COUNT and the eight it runs (the deletion check, the record's and the notes' TYPE, the note's three, the
 * mark, the count).
 */
export const PATH_LEAD_COMMANDS = 9;

/**
 * The deletion check, the erasure note, the mark and the count in one step. KEYS: the erasure notes (lib/erasure-index.ts,
 * noteForErasure), the mark, the store's all-time record, the store's deleted prints (lib/suppression.ts). ARGV: the
 * note's score and cutoff, the notes' seconds, the mark's seconds, the count's field, the address's print.
 *
 * - An address deleted from the store (its print present) writes nothing and answers -2 (Codex T on #3591): a
 *   confirmation that resumes after the erasure never makes the person's mark or note again.
 * - A record or notes of another type write nothing and answer -1.
 * - Otherwise the note is written first, so a mark never stands without it (Codex X8), then the mark, and the count
 *   only when the mark was taken, so a mark never stands without its count (Codex X5): 0 when it was there already,
 *   else the count after one more.
 */
export const PATH_LEAD_COUNT = `-- marktmorgen:path-lead-count:v2
if redis.call('HEXISTS', KEYS[4], ARGV[6]) == 1 then return -2 end
local held = redis.call('TYPE', KEYS[3]).ok
if held ~= 'none' and held ~= 'hash' then return -1 end
local notes = redis.call('TYPE', KEYS[1]).ok
if notes ~= 'none' and notes ~= 'zset' then return -1 end
redis.call('ZADD', KEYS[1], ARGV[1], KEYS[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if not redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[4]) then return 0 end
return redis.call('HINCRBY', KEYS[3], ARGV[5], 1)`;

const markKey = (statsId: string, email: string) =>
  `nl:pathlead:${statsId}:${createHash("sha256").update(`marktmorgen-path-lead:${statsId}:${normaliseEmail(email)}`).digest("hex").slice(0, 32)}`;

/**
 * Counts one confirmed address as a Path lead, once for the store. "counted"
 * when this call counted it, "already" when it was counted before, when the
 * address was deleted from the store, or when the store keeps no numbers or no
 * list (a store with no list has nowhere to note a deletion, so nothing is
 * kept). Throws when the answer is not in its exact shape.
 */
export async function countConfirmedLead(store: { statsId?: string | null; listId?: string | null } | null | undefined, email: string): Promise<"counted" | "already"> {
  const statsId = store?.statsId;
  const listId = store?.listId;
  if (!statsId || !listId || !email || !isRedisConfigured()) return "already";
  const mark = markKey(statsId, email);
  const [[, notes, score, , cutoff], , [, , noteSeconds]] = noteForErasure(statsId, email, mark);
  const [, life, field] = confirmedLeadCommand(statsId);
  const [reply] = repliesFor(await redisPipeline([[
    "EVAL", PATH_LEAD_COUNT, 4, String(notes), mark, String(life), suppressedKey(listId),
    Number(score), String(cutoff), Number(noteSeconds), PATH_LEAD_DAYS * 86_400, String(field), suppressionPrint(listId, email),
  ]]), 1) ?? [undefined];
  if (reply === 0 || reply === -2) return "already";
  if ((countOf(reply) ?? 0) < 1) throw new UnknownReplyError("a Path lead's mark and count");
  return "counted";
}
