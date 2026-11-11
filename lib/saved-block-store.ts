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

/** Keeps a section. "full" when the library has no room for a new one, "gone" when an edited one was removed meanwhile. */
export async function writeSection(statsId: string, section: SavedSection, isNew: boolean, limit: number): Promise<"ok" | "full" | "gone"> {
  const replies = repliesFor(await redisPipeline([["EVAL", SAVE_SECTION, 1, sectionsKey(statsId), section.id, JSON.stringify(section), limit, isNew ? "new" : "edit"]]), 1);
  if (!replies) throw new Error("Saved section write could not be confirmed");
  // Only the script's own whole number counts (CX-123 rule 24): a "1" or a [1] is not a section kept.
  const [answer] = replies;
  const reply = typeof answer === "number" && Number.isSafeInteger(answer) ? answer : null;
  if (reply === 1) return "ok";
  if (reply === 0) return "full";
  if (reply === -2) return "gone";
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
