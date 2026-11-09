/**
 * Refunds Stripe has not finished, kept for a later look by the jobs that take
 * a paid thing back on a full refund (lib/call-meetings.ts, lib/licence-keys.ts,
 * lib/review-proof.ts; rule 30, Claude 5's pre-review of
 * claude5/plan-refund-own-dispute).
 *
 * Each job reads the refunds created since its anchor, newest first. A refund
 * still in requires_action, or pending on a charge not refunded in full yet
 * (unfinishedRefund, lib/refunds.ts), gives nothing back yet but may go
 * through later, keeping its `created`. Holding the anchor at it had no end:
 * one stuck for weeks kept every later run re-reading everything since, and
 * once more than the job's pages of refunds came after it, the run never got
 * down to it again (Stripe lists newest first), so the anchor never moved and
 * the refund, when it went through, was never read.
 *
 * Instead the anchor moves on, and each such refund is kept here by its id in
 * a sorted set, scored by when to look at it next:
 *   - keepRefunds(): keeps a page's unfinished refunds before the anchor can
 *     move past them (ZADD NX, so one already kept keeps its turn; the key's
 *     EXPIRE), at most HELD_REFUND_MAX_KEPT a job and store; one it cannot
 *     keep keeps the job's anchor where it was instead;
 *   - readHeldRefunds(): at most HELD_REFUND_READS due ones a run, each read
 *     back by its id (GET /v1/refunds/{id}, its charge expanded,
 *     docs.stripe.com/api/refunds/retrieve) and taken only when Stripe's reply
 *     is that refund in its exact shape (refundRowKnown). One that now gives
 *     everything back is handed to the job as a row of its reading, and stays
 *     due until the job has handled it (releaseHeld, sent with the job's own
 *     "read" mark), so a run that runs out of lookups or time reads it again;
 *     one still unfinished is looked at again later (every
 *     HELD_REFUND_RECHECK_SECONDS); one that ended without giving everything
 *     back (a partial refund) is let go; one Stripe answers failed or canceled
 *     is let go too, unless the job asked for those (`ended`): then it is
 *     handed to the job beside the rows, and stays due until the job has
 *     handled it, so a mark a pending full refund left can be undone (the
 *     license keys' PENDING_REFUND_SALE; Claude 5's pre-review of
 *     claude5/licence-refunds-combined, HIGH 1); a reply that is not that
 *     refund, or a failed request, is unknown and keeps it for the next look,
 *     never let go;
 *   - requeueHeld(): a job that read a kept refund back but did not handle it
 *     (held, or no lookups or time left) moves it to the back of the due ones,
 *     still due next run, so a few that stay unsettled never take every read
 *     of a run from the others (one command, in place of its release);
 *   - a refund is kept at most HELD_REFUND_MAX_SECONDS from its `created`, the
 *     jobs' own look-back: past it, it is let go without a request. An
 *     unfinished row whose `created` does not read is not kept (its ceiling
 *     cannot be told), and the job keeps its anchor where it was (unknown,
 *     never passed over, never moved back).
 *
 * Each member is "<refund id>|<seconds it is kept from>", so the ceiling needs
 * no request and no second key.
 */
import { refundRowKnown, rowGivesBack, unfinishedRefund, type GivenBackRow } from "@/lib/refunds";
import { onAccount } from "@/lib/stripe-account";
import { redisPipeline } from "@/lib/redis";

type Command = (string | number)[];

/** The most kept refunds one job reads back for one store in one run. */
export const HELD_REFUND_READS = 5;
/** How long a refund is kept for a later look, from its `created`: the jobs' thirty-day look-back. */
export const HELD_REFUND_MAX_SECONDS = 30 * 86_400;
/** When a refund just kept is first looked at again: the next five-minute run. */
export const HELD_REFUND_FIRST_LOOK_SECONDS = 300;
/**
 * The most refunds one job keeps for one store. Each member is at most 4 + 255 + 1 + 10 bytes (REFUND_ID and the
 * seconds), so the set stays under 16 KB (tests/store-data-registry.ts). Past it the job keeps its anchor instead.
 */
export const HELD_REFUND_MAX_KEPT = 50;
/** How often a refund still unfinished is looked at again. */
export const HELD_REFUND_RECHECK_SECONDS = 3_600;

/** A refund's id as Stripe gives one: letters and digits after its prefix, never the member's separator. */
const REFUND_ID = /^(re|pyr)_[A-Za-z0-9]{6,255}$/;

const secondsKnown = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A kept member, read back: its refund id and the time it is kept from; null when it is not one this code wrote. */
function memberOf(member: string): { id: string; from: number } | null {
  const at = member.lastIndexOf("|");
  if (at < 0) return null;
  const id = member.slice(0, at);
  const from = Number(member.slice(at + 1));
  return REFUND_ID.test(id) && secondsKnown(from) && member.slice(at + 1) === String(from) ? { id, from } : null;
}

/**
 * Keeps `rows`' unfinished refunds for a later look under `key`, before the job's anchor can move past them. Returns
 * false when one could not be kept: its id or `created` does not read (its ceiling cannot be told), or keeping it would
 * take the set past HELD_REFUND_MAX_KEPT. The job then does not move its anchor, so those rows stay in its window and
 * are read again next run (unknown, never passed over, never moved back). A refund already past its ceiling is not
 * kept. No request when the rows hold no unfinished refund; otherwise one ZCARD, then the ZADD NX and EXPIRE.
 */
export async function keepRefunds(key: string, rows: readonly GivenBackRow[], nowSeconds: number): Promise<boolean> {
  const pairs: (string | number)[] = [];
  let whole = true;
  for (const row of rows) {
    if (!unfinishedRefund(row)) continue;
    if (typeof row.id !== "string" || !REFUND_ID.test(row.id) || !secondsKnown(row.created)) {
      whole = false;
      continue;
    }
    if (row.created + HELD_REFUND_MAX_SECONDS <= nowSeconds) continue;
    pairs.push(nowSeconds + HELD_REFUND_FIRST_LOOK_SECONDS, `${row.id}|${row.created}`);
  }
  if (!pairs.length) return whole;
  const [count] = await redisPipeline([["ZCARD", key]]);
  // A count that does not read, or a set that would pass its cap (counting every one as new): nothing kept here.
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count + pairs.length / 2 > HELD_REFUND_MAX_KEPT) return false;
  await redisPipeline([
    ["ZADD", key, "NX", ...pairs],
    ["EXPIRE", key, HELD_REFUND_MAX_SECONDS + 86_400],
  ]);
  return whole;
}

/**
 * What a run read back: the kept refunds that now give everything back, as rows; those Stripe answered failed or
 * canceled, when the job asked for them (`ended`); and each one's member by its id.
 */
export type HeldRead = { rows: GivenBackRow[]; ended: GivenBackRow[]; members: Map<string, string> };

/** A refund Stripe answers exactly failed or canceled: it took nothing back, and may undo what it marked while pending. */
const endedRefund = (reply: Record<string, unknown>): boolean => reply.status === "failed" || reply.status === "canceled";

/**
 * Reads back the refunds kept under `key` that are due (at most HELD_REFUND_READS, the longest due first), on the
 * creator's `account`. Returns those that now give everything back, for the job to handle as rows of its reading and
 * then let go (releaseHeld); looks again later at those still unfinished; lets go of those that ended otherwise or are
 * past their ceiling. With `ended`, those Stripe answers failed or canceled are handed to the job too (HeldRead.ended),
 * to be let go once handled, as the rows are. Throws only when the kept set cannot be read: the job then keeps its
 * anchor, as for any failed read.
 */
export async function readHeldRefunds(account: string, key: string, nowSeconds: number, deadline: number, options: { ended?: boolean } = {}): Promise<HeldRead> {
  const read: HeldRead = { rows: [], ended: [], members: new Map() };
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", key, "-inf", nowSeconds, "LIMIT", 0, HELD_REFUND_READS]]);
  if (!Array.isArray(raw) || raw.some((member) => typeof member !== "string")) throw new Error("The kept refunds did not read");
  const writes: Command[] = [];
  const later = (member: string) => writes.push(["ZADD", key, "XX", nowSeconds + HELD_REFUND_RECHECK_SECONDS, member]);
  for (const member of raw as string[]) {
    const kept = memberOf(member);
    if (!kept || kept.from + HELD_REFUND_MAX_SECONDS <= nowSeconds) {
      writes.push(["ZREM", key, member]);
      continue;
    }
    // Out of time: the rest stay due for the next run.
    if (Date.now() >= deadline) break;
    let reply: Record<string, unknown>;
    try {
      reply = await onAccount("GET", account, `/refunds/${encodeURIComponent(kept.id)}?expand[]=charge`);
    } catch (error) {
      console.error("reading a kept refund failed", error);
      later(member);
      continue;
    }
    // Only that refund's own reply, in its exact shape, decides; anything else is unknown and keeps it.
    if (reply.id !== kept.id || reply.object !== "refund" || !refundRowKnown(reply)) later(member);
    else if (rowGivesBack(reply)) {
      read.rows.push(reply);
      read.members.set(kept.id, member);
    } else if (unfinishedRefund(reply)) later(member);
    else if (options.ended && endedRefund(reply)) {
      read.ended.push(reply);
      read.members.set(kept.id, member);
    } else writes.push(["ZREM", key, member]);
  }
  if (writes.length) await redisPipeline(writes);
  return read;
}

/** The command that lets go of a kept refund the job has handled (none when `id` was not read back from the set). */
export function releaseHeld(key: string, held: HeldRead, id: string): Command[] {
  const member = held.members.get(id);
  return member ? [["ZREM", key, member]] : [];
}

/**
 * The commands that move every kept refund read back this run and not let go (still in `held.members`: held by the
 * job, or left for want of lookups or time) behind the others due, still due at the next run. One command a member,
 * in place of its release, so a run never sends both for one member.
 */
export function requeueHeld(key: string, held: HeldRead, nowSeconds: number): Command[] {
  return [...held.members.values()].map((member) => ["ZADD", key, "XX", nowSeconds + HELD_REFUND_FIRST_LOOK_SECONDS, member]);
}
