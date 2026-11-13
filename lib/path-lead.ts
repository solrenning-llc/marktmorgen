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
 * deletion (lib/erasure-index.ts) first, and the note's replies are read
 * exactly before the mark can be set (Codex X8 on #3591), so deleting the
 * person deletes it; a closing store's walk deletes it by the
 * store's id (lib/data-families.ts); otherwise it runs out by itself.
 *
 * Cost (review M2). PATH_LEAD_COMMANDS at the most, as Upstash bills them:
 * the note (three), the script's EVAL and, inside it, the record's TYPE and the
 * mark on every call, and the count once for an address. No public request
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

/** How long an address stays counted for a store: under the erasure index's own 401 days, so the note outlives the mark. */
export const PATH_LEAD_DAYS = 400;
/**
 * The most commands one call is billed (Upstash bills each command a script runs beside the EVAL): the note (3),
 * then the EVAL of PATH_LEAD_COUNT and the three it runs (the life record's TYPE, the mark, the count).
 */
export const PATH_LEAD_COMMANDS = 7;

/**
 * The mark and the count in one step (Codex X5 and X8 on #3591): the mark is taken only when the count is applied with
 * it, so a failure between them can no longer leave an address marked and never counted. KEYS: the mark, the store's
 * all-time record. ARGV: the mark's seconds, the count's field. Answers the count after one more (counted), 0 when the
 * mark was already there (counted before), or -1, having written nothing, when the record is not a hash.
 */
export const PATH_LEAD_COUNT = `-- marktmorgen:path-lead-count:v1
local held = redis.call('TYPE', KEYS[2]).ok
if held ~= 'none' and held ~= 'hash' then return -1 end
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
return redis.call('HINCRBY', KEYS[2], ARGV[2], 1)`;

const markKey = (statsId: string, email: string) =>
  `nl:pathlead:${statsId}:${createHash("sha256").update(`marktmorgen-path-lead:${statsId}:${normaliseEmail(email)}`).digest("hex").slice(0, 32)}`;

/** The note's three replies, exactly: ZADD 0 or 1, ZREMRANGEBYSCORE a count, EXPIRE 1. */
function notedExactly(replies: unknown[] | null): boolean {
  if (!replies || replies.length !== 3) return false;
  const [added, trimmed, kept] = replies;
  return (added === 0 || added === 1) && countOf(trimmed) !== null && kept === 1;
}

/**
 * Counts one confirmed address as a Path lead, once for the store. "counted"
 * when this call counted it, "already" when it was counted before (or no
 * store numbers exist). Throws when an answer is not in its exact shape.
 *
 * The erasure note is written and read back first, on its own: a note missing
 * or unconfirmed throws before any mark exists (Codex X8 on #3591), so no mark
 * is ever left that deleting the person could not find. Then the mark and the
 * count go together in one script.
 */
export async function countConfirmedLead(statsId: string | null | undefined, email: string): Promise<"counted" | "already"> {
  if (!statsId || !email || !isRedisConfigured()) return "already";
  const mark = markKey(statsId, email);
  const noted = noteForErasure(statsId, email, mark);
  if (!notedExactly(repliesFor(await redisPipeline(noted), noted.length))) throw new UnknownReplyError("a Path lead's erasure note");
  const [, life, field] = confirmedLeadCommand(statsId);
  const [reply] = repliesFor(await redisPipeline([["EVAL", PATH_LEAD_COUNT, 2, mark, String(life), PATH_LEAD_DAYS * 86_400, String(field)]]), 1) ?? [undefined];
  if (reply === 0) return "already";
  if ((countOf(reply) ?? 0) < 1) throw new UnknownReplyError("a Path lead's mark and count");
  return "counted";
}
