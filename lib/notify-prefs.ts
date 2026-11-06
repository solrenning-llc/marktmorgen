/**
 * The creator's choice of studio alert emails, kept and read (queue item 601
 * [KB22], unit U6; the catalog and its reasons are in lib/notify-prefs-rules.ts).
 *
 *   nl:notify:off:<statsId>   string   JSON list of the optional events switched off;
 *                                      absent while none is (today's behavior: all on)
 *
 * One key a store, a few dozen bytes, named by the store's stats id, so it
 * goes with the store when it closes (lib/data-families.ts, CLOSING). It names
 * events, never a person, so it holds no personal data.
 *
 * Reading fails toward what cannot be wrong:
 *   - always-on notices never read it (their code does not import this file);
 *   - an optional alert reads it exactly (lib/redis-reply.ts). Absent is "no
 *     choice saved" and every alert is on; a saved list is the creator's last
 *     explicit choice. Any other answer (no reply, another shape, a value this
 *     code did not write, Redis down) is unknown: the caller sends no email
 *     against a choice it cannot read, uses up nothing, and lets the day's
 *     look go so the next hourly run asks again (lib/store-alerts.ts,
 *     lib/quiet-sales.ts). An alert is delayed by an unknown reading, never
 *     sent against an "off" and never lost to it.
 *
 * Redis, per request: a read is one GET; a save is one pipeline of two
 * commands (SET or DEL, then GET to confirm what is there now). The alert
 * jobs read it only on a day with something to email.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { type OptionalEvent, isAlwaysOn, parseOff } from "@/lib/notify-prefs-rules";

const offKey = (statsId: string) => `nl:notify:off:${statsId}`;

/** A GET's answer, exactly: absent is none off, a string must be a list this code wrote, anything else unknown. */
function readReply(reply: unknown): OptionalEvent[] | null {
  if (reply === null) return [];
  if (typeof reply !== "string") return null;
  try {
    return parseOff(JSON.parse(reply));
  } catch {
    return null;
  }
}

/**
 * The optional events the creator switched off, or null when that cannot be
 * read exactly. A store with no stats id has nowhere a choice could be saved
 * (the route makes the id before saving), so nothing is off.
 */
export async function readNotifyOff(statsId: string | null | undefined): Promise<ReadonlySet<OptionalEvent> | null> {
  if (!statsId) return new Set();
  if (!isRedisConfigured()) return null;
  try {
    const replies = repliesFor(await redisPipeline([["GET", offKey(statsId)]]), 1);
    if (!replies) return null;
    const off = readReply(replies[0]);
    return off ? new Set(off) : null;
  } catch {
    return null;
  }
}

export type SaveResult = ReadonlySet<OptionalEvent> | "invalid" | "always_on" | "unknown";

/**
 * Saves the events switched off, replacing what was there. "always_on" for a
 * notice that cannot be switched off, "invalid" for anything else that is not
 * a list of distinct optional events (nothing written either way). "unknown"
 * when the write and the read back did not both answer exactly what was
 * meant: the caller says it could not confirm, never that it saved.
 */
export async function saveNotifyOff(statsId: string, raw: unknown): Promise<SaveResult> {
  if (Array.isArray(raw) && raw.some(isAlwaysOn)) return "always_on";
  const off = parseOff(raw);
  if (!off || (Array.isArray(raw) && off.length !== raw.length)) return "invalid";
  if (!isRedisConfigured()) return "unknown";
  const key = offKey(statsId);
  const value = JSON.stringify(off);
  try {
    const replies = repliesFor(await redisPipeline([off.length ? ["SET", key, value] : ["DEL", key], ["GET", key]]), 2);
    if (!replies) return "unknown";
    const wrote = off.length ? replies[0] === "OK" : countOf(replies[0]) !== null;
    const now = readReply(replies[1]);
    if (!wrote || !now || JSON.stringify(now) !== value) return "unknown";
    return new Set(now);
  } catch {
    return "unknown";
  }
}
