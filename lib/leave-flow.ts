/**
 * The server side of asking why before a member cancels (lib/leave-rules.ts):
 * the answers counted, one counter per answer given, and the reason written
 * on the membership as Stripe's page is opened for cancelling it.
 *
 *   nl:leave:<statsId>:<yyyy-mm>   hash: said:<reason> → n, said:own → n,
 *                                  paused → n, switched → n, left → n; 400 days
 *
 * Every count is made by a press of a button on the page a member reaches by
 * pressing Cancel, never by a page being opened.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { LEAVE_REASONS, isOwnReasonId } from "@/lib/leave-rules";

const KEEP_SECONDS = 400 * 86_400;
const countKey = (statsId: string, month: string) => `nl:leave:${statsId}:${month}`;
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export type LeaveCount = `said:${string}` | "paused" | "switched" | "left";

export async function countLeave(statsId: string | null, field: LeaveCount): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const key = countKey(statsId, monthOf(Date.now()));
  await redisPipeline([
    ["HINCRBY", key, field, 1],
    ["EXPIRE", key, KEEP_SECONDS],
  ]).catch(() => {});
}

/** The field an answer is counted under: each listed reason by itself, the creator's own together. */
export const saidField = (reason: string): LeaveCount => (isOwnReasonId(reason) ? "said:own" : `said:${reason}`);

export type LeaveMonth = { said: number; paused: number; switched: number; left: number };

/** One HMGET slot: nil is never counted; a whole count; anything else is not known (CX-123 rule 24). */
function countIn(raw: unknown): number {
  if (raw === null) return 0;
  if (typeof raw === "string" && /^\d{1,15}$/.test(raw)) return Number(raw);
  throw new UnknownReplyError("a count of the cancel page");
}

/**
 * This month on the store's cancel page: how many said why, paused, switched plan, or went on to cancel. A reply
 * not in HMGET's exact shape throws UnknownReplyError (CX-123 rule 24), never figures with some of them missing.
 */
export async function leaveMonth(statsId: string | null, now = Date.now()): Promise<LeaveMonth> {
  const out: LeaveMonth = { said: 0, paused: 0, switched: 0, left: 0 };
  if (!statsId || !isRedisConfigured()) return out;
  const fields = [...LEAVE_REASONS.map((r) => `said:${r}`), "said:own", "paused", "switched", "left"];
  const [reply] = repliesFor(await redisPipeline([["HMGET", countKey(statsId, monthOf(now)), ...fields]]), 1) ?? [undefined];
  const values = repliesFor(reply, fields.length);
  if (!values) throw new UnknownReplyError("a month of the cancel page");
  fields.forEach((field, i) => {
    const n = countIn(values[i]);
    if (field.startsWith("said:")) out.said += n;
    else out[field as "paused" | "switched" | "left"] += n;
  });
  return out;
}
