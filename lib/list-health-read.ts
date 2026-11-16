/**
 * The seven days of a store's watched list email, read exactly for what the studio shows (570 [DR1], unit 2;
 * CX-123 rule 24; Claude 1 cloud's MEDIUM on #2314). lib/mail-health.ts listHealth reads the same keys loosely: a
 * short pipeline reply, a day row that is not one, or a field that is not a count becomes 0, so a page drawing it
 * would show counts, a level and a distance from a pause that are not known. This reader sends the same commands
 * (one GET and HEALTH_WINDOW_DAYS HMGET, nothing more) and throws UnknownReplyError on any reply it cannot read
 * whole, so the page says "not read just now" instead. Only the studio's table reads it; what admits or pauses
 * list email keeps its own reader (lib/mail-health.ts, Codex H2's exact read).
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError } from "@/lib/redis-reply";
import { HEALTH_WINDOW_DAYS, type Health, mailHealthDayKey } from "@/lib/mail-health";

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** As lib/mail-health.ts writes it: the day a served pause ends, from which the count starts again. */
const fromKey = (id: string) => `nl:mail:health:${id}:from`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COUNT = /^\d{1,15}$/;

/** A field of a day's hash: a count it holds, or 0 when it holds none (nil); anything else is not read. */
function countOf(field: unknown): number | null {
  if (field === null) return 0;
  if (typeof field !== "string" || !COUNT.test(field)) return null;
  const n = Number(field);
  return Number.isSafeInteger(n) ? n : null;
}

/** The last seven days, today included, as listHealth counts them; throws UnknownReplyError on any reply not read whole. */
export async function listHealthExact(id: string, now = Date.now()): Promise<Health> {
  const days: string[] = [];
  for (let i = 0; i < HEALTH_WINDOW_DAYS; i += 1) days.push(dayOf(now - i * 86_400_000));
  const replies: unknown = await redisPipeline([["GET", fromKey(id)], ...days.map((day) => ["HMGET", mailHealthDayKey(id, Date.parse(`${day}T12:00:00Z`)), "s", "b", "c"])]);
  if (!Array.isArray(replies) || replies.length !== days.length + 1) throw new UnknownReplyError("a store's email health");
  const [from, ...rows] = replies as unknown[];
  if (from !== null && (typeof from !== "string" || !DAY.test(from))) throw new UnknownReplyError("a store's email health");
  const total: Health = { sent: 0, bounced: 0, complained: 0 };
  rows.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== 3) throw new UnknownReplyError("a store's email health");
    const [sent, bounced, complained] = row.map(countOf);
    if (sent === null || bounced === null || complained === null) throw new UnknownReplyError("a store's email health");
    // A store that has served a pause starts its count again from the day the pause ends (as listHealth).
    if (typeof from === "string" && days[i] < from) return;
    total.sent += sent;
    total.bounced += bounced;
    total.complained += complained;
  });
  return total;
}
