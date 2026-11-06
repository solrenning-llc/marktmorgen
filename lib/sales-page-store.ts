/**
 * Where a product's page of blocks is kept (lib/sales-page.ts says what it
 * is): one small record per product, under the store's statsId, like the
 * long description.
 *
 * The store's own record says only whether a product has a page (its `page`
 * flag), so the store page — read on every visit — never carries thirty
 * blocks of somebody else's product. The page is read only by the product's
 * own page, the page after a free sign-up and the studio.
 *
 *   nl:product:page:<statsId>:<productId>  -> the page, as JSON
 *   nl:product:pics:<statsId>              -> hash: picture path -> the product whose page shows it
 *   nl:sblock:uses:<statsId>:<section>     -> set: the pages carrying a saved section (lib/saved-block-store.ts),
 *                                             kept with every save
 *   nl:product:pages:<statsId>:<productId> -> list: the page as it was before each of its last
 *                                             five saves, newest first, as "<ms>\n<json>"; kept
 *                                             as long as the page (since 18 October 2026: until
 *                                             then forgotten 30 days after the last save)
 *
 * A page and its earlier versions take room in the store's data room
 * (lib/store-data.ts) before they are written, one slot for the page (with
 * its pictures' and sections' entries) and one for its versions, so a save
 * that does not fit is refused and the page stays as it was.
 *
 * A page's pictures are files in the store's picture folder
 * (lib/product-image.ts). Each belongs to the one page that first showed it,
 * written down in the hash, so that taking a picture off a page — or removing
 * the product — deletes a file no other page is showing, and never one that
 * another page is.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError } from "@/lib/redis-reply";
import { takePictureDoor } from "@/lib/picture-door";
import { EMPTY_PAGE, MAX_STORED_PAGE_BYTES, type SalesPage, parsePage, picturePaths } from "@/lib/sales-page";
import { sectionsOn } from "@/lib/saved-blocks";
import { usesCommands } from "@/lib/saved-block-store";
import { type DataChange, type DataStore, giveData, needData, noteData } from "@/lib/store-data";
import { ENTRY_BYTES, dataBytes } from "@/lib/store-data-rules";

const pageKey = (statsId: string, productId: string) => `nl:product:page:${statsId}:${productId}`;
const picsKey = (statsId: string) => `nl:product:pics:${statsId}`;
const versionsKey = (statsId: string, productId: string) => `nl:product:pages:${statsId}:${productId}`;

/** How many earlier versions of a page are kept. */
export const MAX_VERSIONS = 5;

const PAGE_SLOT = (productId: string) => `pg:${productId}`;
const VERSIONS_SLOT = (productId: string) => `pv:${productId}`;

/** What a page counts for in the store's data room: its record, and an entry for each of its pictures and saved sections. */
function pageBytes(page: SalesPage, json: string): number {
  return dataBytes([json], 1) + (picturePaths(page).length + sectionsOn(page).length) * ENTRY_BYTES + (page.test ? AB_RECORD_BYTES : 0);
}

/**
 * What a headline test's counts weigh at the most (lib/headline-test.ts):
 * eleven fields and the key. Counted with the page while the test is on it,
 * and for TEST_KEPT_DAYS once it is taken off or replaced, which is how long
 * its counts can still be written to and kept: a checkout opened from it is
 * counted for up to forty days, and its record is kept 400 after that.
 */
export const AB_RECORD_BYTES = 1_024;
const TEST_KEPT_DAYS = 440;

/** The id of the headline test a stored record carries, or "". */
function testOfRecord(raw: unknown): string {
  if (typeof raw !== "string" || !raw || raw.length > MAX_STORED_PAGE_BYTES) return "";
  try {
    return parsePage(JSON.parse(raw)).test?.id ?? "";
  } catch {
    return "";
  }
}

/** The counts of a test taken off a page, kept by themselves until they expire. */
const endedTest = (now: number) => ({ until: now + TEST_KEPT_DAYS * 86_400_000, bytes: AB_RECORD_BYTES });

/**
 * Says these pictures are this product's page's. Returns the ones that are
 * not: already shown on another product's page, which keeps them.
 */
export async function claimPictures(statsId: string, productId: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0 || !isRedisConfigured()) return [];
  await redisPipeline(paths.map((path) => ["HSETNX", picsKey(statsId), path, productId]));
  const [owners] = await redisPipeline([["HMGET", picsKey(statsId), ...paths]]);
  const list = Array.isArray(owners) ? owners : [];
  return paths.filter((_, i) => list[i] !== productId);
}

/**
 * Says these pictures, new on this page, are this page's, and returns whether
 * every one of them may be: each has to be let in through the picture door
 * for this very save (lib/picture-door.ts, taken here) or be written down as
 * this page's already (a save tried again after a failure).
 *
 * The store's pictures share one folder, and this registry lists only the
 * pages' pictures: a product's, a link's, a buyer's review photo or an
 * email's picture sit in the same folder unlisted. So a name that is neither
 * fresh from the door nor this page's is refused, never claimed; otherwise
 * taking it off this page later would delete a file another record shows.
 * Another page's picture is refused as before. A picture from before the door
 * existed stays on the page that shows it: it is never new there.
 *
 * Those taken from the door are claimed even when another is refused, so the
 * creator's save tried again still finds them; nothing is deleted here.
 * A take from the door that cannot be confirmed throws (takePictureDoor), so
 * the page is refused with server_error before it is written.
 */
export async function claimNewPictures(statsId: string, pageId: string, paths: string[]): Promise<boolean> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return true;
  // Not known is ours to say, never "add the picture again" (Claude 4 on #2156): it throws, and the route answers
  // server_error before anything is written.
  if (!isRedisConfigured()) throw new UnknownReplyError("page pictures: no database");
  const [owners] = await redisPipeline([["HMGET", picsKey(statsId), ...unique]]);
  if (!Array.isArray(owners) || owners.length !== unique.length) throw new UnknownReplyError("page pictures: HMGET");
  const list = owners;
  // An owner is a name or nobody (null); any other answer is unknown, and throws as the read above does.
  if (list.some((owner) => owner !== null && typeof owner !== "string")) throw new UnknownReplyError("page pictures: an owner");
  if (unique.some((_, i) => typeof list[i] === "string" && list[i] !== "" && list[i] !== pageId)) return false;
  const unclaimed = unique.filter((_, i) => list[i] !== pageId);
  const taken = await takePictureDoor(unclaimed);
  const fresh = unclaimed.filter((path) => taken.has(path));
  if (fresh.length) {
    await redisPipeline(fresh.map((path) => ["HSETNX", picsKey(statsId), path, pageId]));
    const [after] = await redisPipeline([["HMGET", picsKey(statsId), ...fresh]]);
    const now = Array.isArray(after) ? after : [];
    if (fresh.some((_, i) => now[i] !== pageId)) return false;
  }
  return fresh.length === unclaimed.length;
}

/**
 * Lets go of pictures a page no longer shows. Returns the files to delete:
 * only those this product's page was the one showing.
 */
export async function releasePictures(statsId: string, productId: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0 || !isRedisConfigured()) return [];
  const [owners] = await redisPipeline([["HMGET", picsKey(statsId), ...paths]]);
  const list = Array.isArray(owners) ? owners : [];
  const mine = paths.filter((_, i) => list[i] === productId);
  if (mine.length) await redisPipeline([["HDEL", picsKey(statsId), ...mine]]);
  return mine;
}

/** A product's page, or the empty page when it has none (or it cannot be read). */
export async function readPage(statsId: string | null, productId: string): Promise<SalesPage> {
  if (!statsId || !isRedisConfigured()) return { ...EMPTY_PAGE, blocks: [] };
  const [raw] = await redisPipeline([["GET", pageKey(statsId, productId)]]);
  return pageOf(raw);
}

function pageOf(raw: unknown): SalesPage {
  if (typeof raw !== "string" || !raw || raw.length > MAX_STORED_PAGE_BYTES) return { ...EMPTY_PAGE, blocks: [] };
  try {
    return parsePage(JSON.parse(raw));
  } catch {
    return { ...EMPTY_PAGE, blocks: [] };
  }
}

/** Values of many keys, a hundred at a command (MGET): what the whole export reads (lib/store-export.ts). */
async function readMany(keys: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const [raw] = await redisPipeline([["MGET", ...keys.slice(i, i + 100)]]);
    const values = Array.isArray(raw) ? raw : [];
    for (let n = 0; n < Math.min(100, keys.length - i); n += 1) out.push(values[n] ?? null);
  }
  return out;
}

/** The pages of many products, in their order, a hundred at a command. */
export async function readPages(statsId: string | null, productIds: string[]): Promise<SalesPage[]> {
  if (!statsId || !isRedisConfigured()) return productIds.map(() => ({ ...EMPTY_PAGE, blocks: [] }));
  return (await readMany(productIds.map((id) => pageKey(statsId, id)))).map(pageOf);
}

/** Whether a page has anything the product's page should draw instead of its plain layout. */
export function hasBlocks(page: SalesPage): boolean {
  return page.blocks.length > 0;
}

/**
 * Writes a page, or forgets it when it has no blocks and nothing else set.
 * Its room is taken first (DataRoomError when it does not fit); `always`
 * counts it whatever it comes to, for what the store already had.
 */
export async function writePage(statsId: string, productId: string, page: SalesPage, room: DataStore, always = false): Promise<void> {
  const empty = page.blocks.length === 0 && !page.seoTitle && !page.seoDescription && !page.next;
  const json = JSON.stringify(page);
  const key = versionsKey(statsId, productId);
  const [before, kept, oldest] = await redisPipeline([["GET", pageKey(statsId, productId)], ["LLEN", key], ["LINDEX", key, -1]]);
  const commands: (string | number)[][] = [empty ? ["DEL", pageKey(statsId, productId)] : ["SET", pageKey(statsId, productId), json]];
  // What the page was, kept so a save can be undone from the studio. The
  // version pushed takes room; the oldest one it pushes out gives its own back.
  let versions = 0;
  if (typeof before === "string" && before && before !== json && before.length <= MAX_STORED_PAGE_BYTES) {
    const entry = `${Date.now()}\n${before}`;
    versions = dataBytes([entry], 1) - (Number(kept) >= MAX_VERSIONS && typeof oldest === "string" ? dataBytes([oldest], 1) : 0);
    commands.push(["LPUSH", key, entry], ["LTRIM", key, 0, MAX_VERSIONS - 1], ["PERSIST", key]);
  }
  const ended = testOfRecord(before);
  const changes: DataChange[] = [{ slot: PAGE_SLOT(productId), bytes: empty ? 0 : pageBytes(page, json), set: true }, { slot: VERSIONS_SLOT(productId), bytes: versions }];
  if (ended && (empty || page.test?.id !== ended)) changes.push(endedTest(Date.now()));
  if (always) await noteData(room, changes);
  else await needData(room, changes);
  // Which saved sections the page carries, before and after (lib/saved-blocks.ts).
  commands.push(...usesCommands(statsId, productId, sectionsOfRecord(before), empty ? [] : sectionsOn(page)));
  await redisPipeline(commands);
}

/** The saved sections a stored record carries; none when it cannot be read. */
function sectionsOfRecord(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw || raw.length > MAX_STORED_PAGE_BYTES) return [];
  try {
    return sectionsOn(parsePage(JSON.parse(raw)));
  } catch {
    return [];
  }
}

export type PageVersion = { at: number; page: SalesPage };

/** The page as it was before each of its last saves, newest first. */
/**
 * How many versions of a page are kept, read exactly (LLEN) and at most the
 * MAX_VERSIONS readVersions reads, so a reading of them is paid for before it
 * is made (lib/mcp-tools.ts); null when Redis answered in another shape.
 */
export async function countVersions(statsId: string | null, productId: string): Promise<number | null> {
  if (!statsId || !isRedisConfigured()) return 0;
  const replies: unknown = await redisPipeline([["LLEN", versionsKey(statsId, productId)]]);
  if (!Array.isArray(replies) || replies.length !== 1) return null;
  const n = replies[0];
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? Math.min(n, MAX_VERSIONS) : null;
}

/**
 * A product's page exactly as kept, for a reader that must never take an
 * answer it does not know for an empty page (the MCP tools): null when no
 * page is kept; throws when Redis's answer is not exactly one text or null,
 * or when the kept record is not a page.
 */
export async function readPageExact(statsId: string, productId: string): Promise<{ page: SalesPage | null; bytes: number }> {
  if (!isRedisConfigured()) throw new Error("the page could not be read");
  const reply: unknown = await redisPipeline([["GET", pageKey(statsId, productId)]]);
  if (!Array.isArray(reply) || reply.length !== 1) throw new Error("the page could not be read");
  const raw = reply[0];
  if (raw === null) return { page: null, bytes: 0 };
  if (typeof raw !== "string" || !raw || raw.length > MAX_STORED_PAGE_BYTES) throw new Error("the page could not be read");
  return { page: pageRecordExact(raw, "the page could not be read"), bytes: Buffer.byteLength(raw, "utf8") };
}

/** A kept page record decoded: an object with its list of blocks, before the forgiving normalization; anything else throws (Codex J on #1821: JSON null or [] is not an empty page). */
function pageRecordExact(json: string, what: string): SalesPage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    throw new Error(what);
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded) || !Array.isArray((decoded as { blocks?: unknown }).blocks)) throw new Error(what);
  try {
    return parsePage(decoded);
  } catch {
    throw new Error(what);
  }
}

/**
 * A page's kept versions exactly as kept, newest first, for a reader that must
 * never take an answer it does not know for "no versions" (the MCP tools):
 * throws when Redis's answer is not exactly one list of texts, or when a kept
 * version is not one, so nothing is left out unsaid.
 */
export async function readVersionsExact(statsId: string, productId: string): Promise<{ versions: PageVersion[]; bytes: number }> {
  if (!isRedisConfigured()) throw new Error("the page's versions could not be read");
  const reply: unknown = await redisPipeline([["LRANGE", versionsKey(statsId, productId), 0, MAX_VERSIONS - 1]]);
  if (!Array.isArray(reply) || reply.length !== 1 || !Array.isArray(reply[0])) throw new Error("the page's versions could not be read");
  const versions: PageVersion[] = [];
  let bytes = 0;
  for (const entry of reply[0] as unknown[]) {
    if (typeof entry !== "string") throw new Error("the page's versions could not be read");
    bytes += Buffer.byteLength(entry, "utf8");
    const cut = entry.indexOf("\n");
    const at = Number(entry.slice(0, cut));
    if (cut < 1 || !Number.isFinite(at)) throw new Error("the page's versions could not be read");
    versions.push({ at, page: pageRecordExact(entry.slice(cut + 1), "the page's versions could not be read") });
  }
  return { versions, bytes };
}

export async function readVersions(statsId: string | null, productId: string): Promise<PageVersion[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const [list] = await redisPipeline([["LRANGE", versionsKey(statsId, productId), 0, MAX_VERSIONS - 1]]);
  if (!Array.isArray(list)) return [];
  const out: PageVersion[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const cut = entry.indexOf("\n");
    const at = Number(entry.slice(0, cut));
    if (cut < 1 || !Number.isFinite(at)) continue;
    try {
      out.push({ at, page: parsePage(JSON.parse(entry.slice(cut + 1))) });
    } catch {
      // A version that cannot be read is left out, never shown half.
    }
  }
  return out;
}

/** Forgets the page of a product that is gone, and gives back its room. Returns the picture files it was the one showing, to delete. */
export async function dropPage(statsId: string | null, productId: string, room: DataStore): Promise<string[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const held = await readPage(statsId, productId).catch(() => ({ ...EMPTY_PAGE, blocks: [] }));
  const shown = picturePaths(held);
  await redisPipeline([["DEL", pageKey(statsId, productId), versionsKey(statsId, productId)], ...usesCommands(statsId, productId, sectionsOn(held), [])]);
  await giveData(room, [{ slot: PAGE_SLOT(productId), bytes: 0, set: true }, { slot: VERSIONS_SLOT(productId), bytes: 0, set: true }]);
  // A test's counts stay until they expire, counted on their own.
  if (held.test) await noteData(room, [endedTest(Date.now())]);
  return releasePictures(statsId, productId, shown);
}
