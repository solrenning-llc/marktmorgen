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
 * them; what decides is the mark, taken with SET NX and read exactly: "OK"
 * counts, nil (already counted: the same address, by any path, any product,
 * written any way) counts nothing, and any other answer counts nothing and
 * throws, so a lead may be missed, never counted twice (rule 24). An address
 * counts once in PATH_LEAD_DAYS; after the mark runs out it can count again.
 *
 * The count. "lc" on the store's all-time record (lib/stats.ts,
 * confirmedLeadCommand), one HINCRBY of its own outside the record's capped
 * count, so a record already at LIFE_WRITE_MAX never hides it under "~"
 * (review L4); its answer is read exactly and an unknown one throws, which
 * the routes log.
 *
 * Privacy. The mark holds a one-way fingerprint of the store's id and the
 * normalized address, never the address. It is noted for the person's
 * deletion (lib/erasure-index.ts) in the same trip, before the mark is set,
 * so deleting the person deletes it; a closing store's walk deletes it by the
 * store's id (lib/data-families.ts); otherwise it runs out by itself.
 *
 * Cost (review M2). PATH_LEAD_COMMANDS at the most: the note (three) and the
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
/** The most commands one call sends: the note (3) and the mark, then the count. */
export const PATH_LEAD_COMMANDS = 5;

const markKey = (statsId: string, email: string) =>
  `nl:pathlead:${statsId}:${createHash("sha256").update(`marktmorgen-path-lead:${statsId}:${normaliseEmail(email)}`).digest("hex").slice(0, 32)}`;

/**
 * Counts one confirmed address as a Path lead, once for the store. "counted"
 * when this call counted it, "already" when it was counted before (or no
 * store numbers exist). Throws when an answer is not in its exact shape.
 */
export async function countConfirmedLead(statsId: string | null | undefined, email: string): Promise<"counted" | "already"> {
  if (!statsId || !email || !isRedisConfigured()) return "already";
  const mark = markKey(statsId, email);
  const noted = noteForErasure(statsId, email, mark);
  const replies = repliesFor(await redisPipeline([...noted, ["SET", mark, "1", "NX", "EX", PATH_LEAD_DAYS * 86_400]]), noted.length + 1);
  const taken = replies?.[noted.length];
  if (taken === null) return "already";
  if (taken !== "OK") throw new UnknownReplyError("a Path lead's mark");
  const [count] = repliesFor(await redisPipeline([confirmedLeadCommand(statsId)]), 1) ?? [undefined];
  if ((countOf(count) ?? 0) < 1) throw new UnknownReplyError("the confirmed leads' count");
  return "counted";
}
