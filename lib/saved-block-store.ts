/**
 * Where a store's saved sections are kept (lib/saved-blocks.ts has the
 * rules), and which pages use each.
 *
 *   nl:sblocks:<statsId>              hash: section id -> the section, as JSON
 *   nl:sblock:uses:<statsId>:<id>     set: the keys of the pages that carry it
 *                                     (a product's id, or site-<page id>)
 *
 * The set is written with every page save (lib/sales-page-store.ts), so the
 * list of pages using a section never needs every page read. It may hold a
 * page that has since dropped the section; whoever reads it checks the page.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { type SavedSection, parseSection } from "@/lib/saved-blocks";
import { storeLiveFence } from "@/lib/store-live-cache";
import type { Store } from "@/lib/store";

const sectionsKey = (statsId: string) => `nl:sblocks:${statsId}`;
export const sectionUsesKey = (statsId: string, id: string) => `nl:sblock:uses:${statsId}:${id}`;

/** Every section of a store, newest change first. Throws when the list cannot be read, so an empty list is never a guess. */
/**
 * How many sections the library holds, read exactly (HLEN), so a reading of
 * them is paid for before it is made (lib/mcp-tools.ts savedBlocksTool);
 * null when Redis answered in another shape.
 */
export async function countSections(statsId: string | null): Promise<number | null> {
  if (!statsId || !isRedisConfigured()) return 0;
  const replies: unknown = await redisPipeline([["HLEN", sectionsKey(statsId)]]);
  if (!Array.isArray(replies) || replies.length !== 1) return null;
  const n = replies[0];
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export async function readSections(statsId: string | null): Promise<SavedSection[]> {
  if (!statsId || !isRedisConfigured()) throw new Error("Saved sections unavailable");
  const replies = await redisPipeline([["HVALS", sectionsKey(statsId)]]);
  if (replies.length !== 1 || !Array.isArray(replies[0])) throw new Error("Saved sections unavailable");
  return (replies[0] as unknown[])
    .flatMap((value) => {
      try {
        const section = parseSection(JSON.parse(String(value)));
        return section ? [section] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/**
 * The library exactly as kept, for a reader that must never leave a section
 * out unsaid (the MCP tools): throws when Redis's answer is not exactly one
 * list of texts or a kept section is not one.
 */
export async function readSectionsExact(statsId: string): Promise<{ sections: SavedSection[]; bytes: number }> {
  if (!isRedisConfigured()) throw new Error("Saved sections unavailable");
  const replies: unknown = await redisPipeline([["HVALS", sectionsKey(statsId)]]);
  if (!Array.isArray(replies) || replies.length !== 1 || !Array.isArray(replies[0])) throw new Error("Saved sections unavailable");
  const sections: SavedSection[] = [];
  let bytes = 0;
  for (const value of replies[0] as unknown[]) {
    if (typeof value !== "string") throw new Error("Saved sections unavailable");
    bytes += Buffer.byteLength(value, "utf8");
    let section: SavedSection | null = null;
    try {
      section = parseSection(JSON.parse(value));
    } catch {
      section = null;
    }
    if (!section) throw new Error("Saved sections unavailable");
    sections.push(section);
  }
  return { sections, bytes };
}

export async function readSection(statsId: string, id: string): Promise<SavedSection | null> {
  const [raw] = await redisPipeline([["HGET", sectionsKey(statsId), id]]);
  if (typeof raw !== "string") return null;
  try {
    return parseSection(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Capacity and identity are checked with the write: a new section only while
 * the library has room, an edit only of a section that is still there.
 * No application code writes with it any more: saved sections (writeSection)
 * and saved sales filters (lib/sales-filters.ts) run SAVE_STORE_SECTION, which
 * runs these same checks after the store's fence. It stays exported, unchanged,
 * only for scripts/test_funnel_share_redis.py, which races these checks on a
 * real Redis, and for tests/saved-section-store-erasure.test.ts.
 */
export const SAVE_SECTION = `-- marktmorgen:saved-section:v1
local kind = redis.call("TYPE", KEYS[1]).ok
if kind ~= "none" and kind ~= "hash" then return -3 end
local exists = redis.call("HEXISTS", KEYS[1], ARGV[1])
if ARGV[4] == "new" then
  if exists == 1 then return -2 end
  if redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
elseif ARGV[4] ~= "edit" or exists == 0 then return -2 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return 1`;

/**
 * SAVE_SECTION for a store's own library, fenced by the store (#5010 row 126, Codex X4-20261119-1750), by the rule of
 * store-cache-live:v3 (lib/live-fence.ts): KEYS[2] the store's live key (its id key, or for a store from before ids its
 * owner's record) and KEYS[3] the erasing hash; ARGV[5] the store's erasing field, ARGV[6] "" for a store with an id
 * (whose id key must hold ARGV[7], the store's ref) or the statsId its record must carry. Read in the same step as the
 * write, so a save that waited while the store was erased, started erasing or was moved writes nothing, and the erased
 * store's nl:sblocks: library is never made again. -4: gone, erasing or moved, nothing written; -5: the owner's record
 * did not parse (unknown); otherwise SAVE_SECTION's own answers. It is also the write of a store's saved sales filters
 * (lib/sales-filters.ts, #5285 row #5277).
 */
export const SAVE_STORE_SECTION = `-- marktmorgen:saved-store-section:v1
if redis.call("HGET", KEYS[3], ARGV[5]) then return -4 end
if ARGV[6] == "" then
  if redis.call("GET", KEYS[2]) ~= ARGV[7] then return -4 end
else
  local raw = redis.call("GET", KEYS[2])
  if not raw then return -4 end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= "table" then return -5 end
  if record["statsId"] ~= ARGV[6] then return -4 end
end
local kind = redis.call("TYPE", KEYS[1]).ok
if kind ~= "none" and kind ~= "hash" then return -3 end
local exists = redis.call("HEXISTS", KEYS[1], ARGV[1])
if ARGV[4] == "new" then
  if exists == 1 then return -2 end
  if redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
elseif ARGV[4] ~= "edit" or exists == 0 then return -2 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return 1`;

/**
 * The billed commands of one section save at its worst, as Upstash bills a script (the EVAL and every redis.call
 * written in it): the EVAL, the erasing field, the live key, TYPE, HEXISTS, HLEN and HSET, and the second GET of the
 * legacy branch counted too, since each written call is a bound on its branch.
 */
export const SAVE_STORE_SECTION_COMMANDS = 1 + (SAVE_STORE_SECTION.match(/redis\.call\(/g) ?? []).length;

/**
 * Keeps a section of `store`'s library, only while the store is live (SAVE_STORE_SECTION). "full" when the library has
 * no room for a new one, "gone" when an edited one was removed meanwhile or the store is erased, erasing or moved
 * (nothing is written then). A store from before ids with no statsId cannot be told from another: nothing is written,
 * and the save is not confirmed.
 */
export async function writeSection(store: Pick<Store, "email" | "sid" | "extra" | "statsId">, section: SavedSection, isNew: boolean, limit: number): Promise<"ok" | "full" | "gone"> {
  const statsId = store.statsId;
  if (!statsId) throw new Error("Saved section write could not be confirmed");
  const fence = await storeLiveFence(store);
  if (fence.statsId === null) throw new Error("Saved section write could not be confirmed");
  const replies = repliesFor(await redisPipeline([["EVAL", SAVE_STORE_SECTION, 3, sectionsKey(statsId), fence.live, fence.erasing, section.id, JSON.stringify(section), limit, isNew ? "new" : "edit", fence.field, fence.statsId, fence.ref]]), 1);
  if (!replies) throw new Error("Saved section write could not be confirmed");
  // Only the script's own whole number counts (CX-123 rule 24): a "1" or a [1] is not a section kept.
  const [answer] = replies;
  const reply = typeof answer === "number" && Number.isSafeInteger(answer) ? answer : null;
  if (reply === 1) return "ok";
  if (reply === 0) return "full";
  if (reply === -2 || reply === -4) return "gone";
  throw new Error("Saved section write could not be confirmed");
}

/** Removes a section from the library. Pages keep the blocks they have; they are simply no longer tied to it. */
export async function dropSection(statsId: string, id: string): Promise<boolean> {
  const replies = repliesFor(await redisPipeline([["HDEL", sectionsKey(statsId), id], ["DEL", sectionUsesKey(statsId, id)]]), 2);
  // HDEL's own count, exactly (CX-123 rule 24): anything else is not known to be removed, nor known to be absent.
  const removed = replies ? countOf(replies[0]) : null;
  if (removed === null) throw new UnknownReplyError("a saved section's removal");
  return removed === 1;
}

/** The pages that carry a section, as written down; each still has to be read to be sure. */
export async function sectionUses(statsId: string, id: string): Promise<string[]> {
  const replies = await redisPipeline([["SMEMBERS", sectionUsesKey(statsId, id)]]);
  if (replies.length !== 1 || !Array.isArray(replies[0])) throw new Error("Section uses unavailable");
  return (replies[0] as unknown[]).filter((key): key is string => typeof key === "string" && /^(site-[a-z0-9]{10}|[A-Za-z0-9_-]{1,40})$/.test(key)).sort();
}

/** The commands that keep the uses written down when a page goes from carrying `before` to carrying `after`. */
export function usesCommands(statsId: string, pageKey: string, before: readonly string[], after: readonly string[]): (string | number)[][] {
  const commands: (string | number)[][] = [];
  for (const id of before) if (!after.includes(id)) commands.push(["SREM", sectionUsesKey(statsId, id), pageKey]);
  // Always written for what the page carries now, so a set that lost a page gets it back on the next save.
  for (const id of after) commands.push(["SADD", sectionUsesKey(statsId, id), pageKey]);
  return commands;
}
