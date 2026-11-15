/**
 * Taking the daily course job's start reads from the store's monthly figure (lib/drip-start-rules.ts, dripMonthUnits)
 * before each read is made (lib/learn.ts, sendDripEmails; Claude 2's MEDIUM on #3369):
 *
 *   nl:dripstart:<store>:<window>   units taken in the store's allowance window
 *
 * All or nothing: what does not fit is refused and given back. A store that pays nothing must hold one of the
 * month's places (lib/free-pool.ts), as for every figure that costs. Unknown is closed (CX-123 rule 24): no window,
 * no place that could be read, or a count that is not exactly the INCRBY and EXPIRE NX replies, and the read is not
 * made; a count that may have landed is left counted higher, never lower.
 */
import { allowanceWindow, keepSecondsFor } from "@/lib/allowance-window";
import { dripMonthUnits } from "@/lib/drip-start-rules";
import { poolPlace } from "@/lib/free-pool";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";

/** "taken": the read may be made; "used": the window's figure (or the month's places) is spent; "unknown": not counted. */
export type DripTaken = "taken" | "used" | "unknown";

const key = (id: string, window: string) => `nl:dripstart:${id}:${window}`;

/**
 * What a store is counted by: its own id, one of those its closing walk erases its keys by (lib/closed-store-data.ts,
 * marksOf; lib/data-families.ts CLOSING "nl:dripstart:"). A store with neither is not counted, so nothing is read.
 */
function idOf(store: Store): string | null {
  const id = store.sid || store.statsId || "";
  return id.length >= 6 ? id : null;
}

export async function takeDripStartUnits(store: Store, units: number, now = Date.now()): Promise<DripTaken> {
  if (!Number.isSafeInteger(units) || units < 1) return "unknown";
  const limit = dripMonthUnits(store, now / 1000);
  if (!Number.isSafeInteger(limit) || limit < units) return "used";
  const window = allowanceWindow(store, now);
  const id = idOf(store);
  if (!window || !id || !isRedisConfigured()) return "unknown";
  const place = await poolPlace(store, now);
  if (place === "full") return "used";
  if (place !== "in") return "unknown";
  const k = key(id, window.id);
  let counted: number | null = null;
  try {
    // INCRBY first, then the window's expiry only when the key has none (EXPIRE … NX), as lib/window-count.ts counts
    // (9bad368379): a SET NX EX before the INCRBY did nothing when the key was there, and if the key expired between
    // the two the INCRBY made it again with no expiry, so the store's figure would stay spent for good.
    const replies = repliesFor(await redisPipeline([
      ["INCRBY", k, units],
      ["EXPIRE", k, keepSecondsFor(window, now), "NX"],
    ]), 2);
    // Exactly a whole count of at least what this took for the INCRBY, and 0 or 1 for the EXPIRE.
    const total = replies?.[0];
    if (replies && (replies[1] === 0 || replies[1] === 1) && typeof total === "number" && Number.isSafeInteger(total) && total >= units) counted = total;
  } catch {
    counted = null;
  }
  if (counted === null) return "unknown";
  if (counted <= limit) return "taken";
  // Over: what this asked for is given back, so a refused read costs the figure nothing; a give-back that fails
  // leaves the figure counted higher, never lower.
  await redisPipeline([["DECRBY", k, units]]).catch(() => {});
  return "used";
}
