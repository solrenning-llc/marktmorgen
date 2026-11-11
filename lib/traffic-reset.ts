/**
 * The person who runs the site lowers a store's count of visits in its
 * current window (TODOS-51 D): after visits that should not have counted,
 * a store resting on its visits can open again without waiting for the
 * next window.
 *
 * What it may do, and nothing more:
 *   - lower the visits of the store's current window, as admission reads
 *     them (the people who came plus the live room's hundredths made into
 *     whole visits), to a figure the operator gives, by lowering the people
 *     only; never raise them, never below zero, and refuse a figure below what
 *     the live room alone holds, since the room is never given back;
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
import { randomBytes } from "node:crypto";
import { allowanceWindow } from "@/lib/allowance-window";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { type Store, storeFolder, storeRef } from "@/lib/store";
import { countKey, partsKey } from "@/lib/traffic";
import { PARTS_PER_VISIT } from "@/lib/traffic-rules";

/** How many resets are kept in the record, the newest first. */
export const TRAFFIC_LOG_KEEP = 1_000;

const LOG_KEY = "nl:operator:traffic-log";
const LOCK_KEY = "nl:operator:traffic-reset:lock";
const LOCK_SECONDS = 30;

/**
 * Under this reset's own lock token only (KEYS[4], ARGV[4]): a people count or a live room in another shape writes
 * nothing; a people count lower than the one read (another reset got in) writes nothing; otherwise the record first,
 * then the people lowered by the delta, so visits counted meanwhile stay counted. Both or neither. Answers the people
 * left and the live room as it is now, so the caller says the visits as admission reads them.
 */
const RESET_SCRIPT = `-- marktmorgen:traffic-reset:v2
if redis.call('GET', KEYS[4]) ~= ARGV[4] then return {-2} end
local current = redis.call('GET', KEYS[1])
if current == false then current = '0' end
if not string.match(current, '^%d+$') then return {-3} end
local room = redis.call('GET', KEYS[2])
if room == false then room = '0' end
if not string.match(room, '^%d+$') then return {-3} end
if tonumber(current) < tonumber(ARGV[1]) then return {-1, tonumber(current)} end
redis.call('LPUSH', KEYS[3], ARGV[3])
redis.call('LTRIM', KEYS[3], 0, tonumber(ARGV[5]) - 1)
return {1, redis.call('DECRBY', KEYS[1], ARGV[2]), tonumber(room)}`;

/** The lock let go only by the token that took it. */
const RELEASE_SCRIPT = `-- marktmorgen:traffic-reset-release:v1
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
const FOLDER_PATTERN = /^[0-9a-f]{32}$/;

export type TrafficReset = { at: number; sid: string; handle: string; window: string; before: number; after: number };

export type ResetResult =
  | { ok: true; window: string; before: number; after: number }
  | { ok: false; reason: "invalid" | "no-window" | "busy" | "unknown" }
  | { ok: false; reason: "above" | "same" | "room"; before: number };

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
  const roomKey = partsKey(folder, window.id);

  // The lock is this reset's own token: a reset that waited past its lease can neither change the visits (the
  // script checks the token) nor let go of a lock another reset now holds (the release checks it too).
  const token = randomBytes(16).toString("hex");
  const lock = repliesFor(await redisPipeline([["SET", LOCK_KEY, token, "NX", "EX", LOCK_SECONDS]]), 1);
  if (!lock) return { ok: false, reason: "unknown" };
  if (lock[0] !== "OK") return lock[0] === null ? { ok: false, reason: "busy" } : { ok: false, reason: "unknown" };
  try {
    // The visits as admission and the plan limit read them (lib/traffic.ts trafficForAdmission): the people plus the
    // live room's hundredths made into whole visits (Claude 1's MEDIUM on #3380). Only the people are lowered.
    const read = repliesFor(await redisPipeline([["GET", key], ["GET", roomKey]]), 2);
    const people = read ? storedCount(read[0]) : null;
    const room = read ? storedCount(read[1]) : null;
    if (people === null || room === null) return { ok: false, reason: "unknown" };
    const roomVisits = Math.floor(room / PARTS_PER_VISIT);
    const before = people + roomVisits;
    if (!Number.isSafeInteger(before)) return { ok: false, reason: "unknown" };
    if (to > before) return { ok: false, reason: "above", before };
    if (to === before) return { ok: false, reason: "same", before };
    // The live room alone holds more than the figure asked for: it is never given back here, so it cannot be reached.
    if (to < roomVisits) return { ok: false, reason: "room", before };
    // One script: the record, then the people lowered by what was asked, both or neither (Codex M on #3380).
    const entry: TrafficReset = { at: now, sid: store.sid, handle: store.handle, window: window.id, before, after: to };
    const replies = repliesFor(
      await redisPipeline([
        ["EVAL", RESET_SCRIPT, 4, key, roomKey, LOG_KEY, LOCK_KEY, String(people), String(before - to), JSON.stringify(entry), token, TRAFFIC_LOG_KEEP],
      ]),
      1,
    );
    const answer = replies && Array.isArray(replies[0]) ? (replies[0] as unknown[]) : null;
    if (answer && answer[0] === -2) return { ok: false, reason: "busy" };
    const whole = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const after = answer && answer[0] === 1 && answer.length === 3 && whole(answer[1]) && whole(answer[2]) ? (answer[1] as number) + Math.floor((answer[2] as number) / PARTS_PER_VISIT) : null;
    // DECRBY keeps visits counted while this ran, and the live room only grows: the visits are `to` plus them, never
    // less than `to`.
    if (after === null || after < to) return { ok: false, reason: "unknown" };
    return { ok: true, window: window.id, before, after };
  } finally {
    await redisPipeline([["EVAL", RELEASE_SCRIPT, 1, LOCK_KEY, token]]).catch(() => undefined);
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
