/**
 * The person who runs the site lowers a store's count of visits in its
 * current window (TODOS-51 D): after visits that should not have counted,
 * a store resting on its visits can open again without waiting for the
 * next window.
 *
 * What it may do, and nothing more:
 *   - lower the visits of the store's current window to a
 *     figure the operator gives, never raise them and never below zero;
 *   - never touch the window's requests, its connections'
 *     shares or the live room: the requests' ceiling is what bounds what the
 *     store's pages cost us in a window, so it is never given back here
 *     (owner's rule MR: no cost past a plan's worst case);
 *   - write the record first: when, which store, which window, the count it
 *     read and the figure asked for, the newest first, at most
 *     TRAFFIC_LOG_KEEP. No address is kept; there is one operator.
 *
 * Every reply is read exactly (CX-123 rule 24): a count in another shape, or
 * a change whose answer is lost, is unknown and never said done. One reset at
 * a time, under a short lock, so two at once cannot lower the count twice.
 */
import { allowanceWindow } from "@/lib/allowance-window";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { type Store, storeFolder, storeRef } from "@/lib/store";
import { countKey } from "@/lib/traffic";

/** How many resets are kept in the record, the newest first. */
export const TRAFFIC_LOG_KEEP = 1_000;

const LOG_KEY = "nl:operator:traffic-log";
const LOCK_KEY = "nl:operator:traffic-reset:lock";
const LOCK_SECONDS = 30;
const FOLDER_PATTERN = /^[0-9a-f]{32}$/;

export type TrafficReset = { at: number; sid: string; handle: string; window: string; before: number; after: number };

export type ResetResult =
  | { ok: true; window: string; before: number; after: number }
  | { ok: false; reason: "invalid" | "no-window" | "busy" | "unknown" }
  | { ok: false; reason: "above" | "same"; before: number };

/** A count as Redis keeps it: digits only, a whole number from zero up; a missing key is zero. Anything else is null. */
function storedCount(reply: unknown): number | null {
  if (reply === null) return 0;
  if (typeof reply !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(reply)) return null;
  const value = Number(reply);
  return Number.isSafeInteger(value) ? value : null;
}

/** Lowers this store's visits in its current window to `to`. Never raises them; never touches anything else. */
export async function resetVisits(input: { store: Store; to: number; now?: number }): Promise<ResetResult> {
  const { store, to } = input;
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(to) || to < 0) return { ok: false, reason: "invalid" };
  const window = allowanceWindow(store, now);
  if (!window || !isRedisConfigured()) return { ok: false, reason: "no-window" };
  const folder = await storeFolder(storeRef(store));
  if (!FOLDER_PATTERN.test(folder)) return { ok: false, reason: "unknown" };
  const key = countKey(folder, window.id);

  const lock = repliesFor(await redisPipeline([["SET", LOCK_KEY, String(now), "NX", "EX", LOCK_SECONDS]]), 1);
  if (!lock) return { ok: false, reason: "unknown" };
  if (lock[0] !== "OK") return lock[0] === null ? { ok: false, reason: "busy" } : { ok: false, reason: "unknown" };
  try {
    const read = repliesFor(await redisPipeline([["GET", key]]), 1);
    const before = read ? storedCount(read[0]) : null;
    if (before === null) return { ok: false, reason: "unknown" };
    if (to > before) return { ok: false, reason: "above", before };
    if (to === before) return { ok: false, reason: "same", before };
    // The record goes first in the same pipeline, so a change is never made without it.
    const entry: TrafficReset = { at: now, sid: store.sid, handle: store.handle, window: window.id, before, after: to };
    const replies = repliesFor(
      await redisPipeline([
        ["LPUSH", LOG_KEY, JSON.stringify(entry)],
        ["LTRIM", LOG_KEY, 0, TRAFFIC_LOG_KEEP - 1],
        ["DECRBY", key, before - to],
      ]),
      3,
    );
    const pushed = replies ? countOf(replies[0]) : null;
    const left = replies && typeof replies[2] === "number" && Number.isSafeInteger(replies[2]) ? replies[2] : null;
    // DECRBY keeps visits counted while this ran: the count is `to` plus them, never less than `to`.
    if (!replies || pushed === null || pushed < 1 || replies[1] !== "OK" || left === null || left < to) return { ok: false, reason: "unknown" };
    return { ok: true, window: window.id, before, after: left };
  } finally {
    await redisPipeline([["DEL", LOCK_KEY]]).catch(() => undefined);
  }
}

/** The record of resets, the newest first; null when it does not read. */
export async function readTrafficLog(): Promise<TrafficReset[] | null> {
  if (!isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["LRANGE", LOG_KEY, 0, TRAFFIC_LOG_KEEP - 1]]), 1);
  if (!replies || !Array.isArray(replies[0])) return null;
  const entries: TrafficReset[] = [];
  for (const raw of replies[0]) {
    if (typeof raw !== "string") return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    const entry = value as Record<string, unknown>;
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(entry.at) || typeof entry.sid !== "string" || typeof entry.handle !== "string" || typeof entry.window !== "string" ||
      !Number.isSafeInteger(entry.before) || !Number.isSafeInteger(entry.after)
    ) return null;
    entries.push({ at: entry.at as number, sid: entry.sid, handle: entry.handle, window: entry.window, before: entry.before as number, after: entry.after as number });
  }
  return entries;
}
