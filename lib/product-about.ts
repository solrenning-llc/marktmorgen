/**
 * The long description of a product: everything the 300 characters on the
 * store card cannot hold. What is inside, who it is for, what the buyer gets
 * and how.
 *
 * It is plain text, written the way people write in a message box: a blank
 * line starts a new paragraph, a line starting with "- " is a point in a
 * list, and an https address becomes a link. No markup is ever read from it,
 * so nothing a creator types — or pastes from somewhere else — can put a
 * script, a style or a hidden element on their page. The page builds every
 * element itself from the pieces below.
 *
 * It is kept in its own small record rather than inside the store's, because
 * the store's record is read on every visit to the store page and this text
 * is read only on the product's own page. Two hundred products with a long
 * description each would otherwise be carried by every visitor for nothing.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { type DataStore, giveData, needData, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

/** Room for a proper sales page, and still something a person reads. */
export const MAX_ABOUT_LENGTH = 5_000;

const aboutKey = (statsId: string, productId: string) => `nl:product:about:${statsId}:${productId}`;

/** Normalises what was typed: line endings, trailing space, and the length. */
export function cleanAbout(raw: string, max = MAX_ABOUT_LENGTH): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/**
 * The description of one product, or "" when Redis confirms it has none (a GET
 * that answers null). Any other answer (no reply, more than one, a slot that
 * is not a text) throws UnknownReplyError, so an export or a page never says
 * "no description" about one it could not read (CX-123 rule 24; Codex T's
 * proof, 46e2cc9). A failed request throws as before.
 */
export async function readAbout(statsId: string | null, productId: string): Promise<string> {
  if (!statsId || !isRedisConfigured()) return "";
  const replies = repliesFor(await redisPipeline([["GET", aboutKey(statsId, productId)]]), 1);
  if (!replies) throw new UnknownReplyError("a description read");
  return aboutOf(replies[0]);
}

/**
 * A kept description from its GET or MGET slot: null is "none kept", a text is
 * the description, anything else throws. Every text is a description:
 * writeAbout stores the text it is given as it is (and never an empty one, which
 * it deletes instead), so no text is refused; the length is cut as before.
 */
function aboutOf(raw: unknown): string {
  if (raw === null) return "";
  if (typeof raw !== "string") throw new UnknownReplyError("a kept description");
  return raw.slice(0, MAX_ABOUT_LENGTH);
}

/**
 * The description of one product, read only in its exact shape: a text, or
 * "" when Redis answers it has none (nil). Any other answer is unknown and
 * throws, never read as none (Codex G on #1856): what decides whether a
 * change was made may not be taken from a reply that says nothing.
 */
export async function readAboutExact(statsId: string, productId: string): Promise<string> {
  const reply: unknown = await redisPipeline([["GET", aboutKey(statsId, productId)]]);
  if (!Array.isArray(reply) || reply.length !== 1 || (reply[0] !== null && typeof reply[0] !== "string")) {
    throw new Error("a description was answered in an unknown shape");
  }
  return typeof reply[0] === "string" ? reply[0].slice(0, MAX_ABOUT_LENGTH) : "";
}

/**
 * Values of many keys, a hundred at a command (MGET): what the whole export
 * reads (lib/store-export.ts). Each command must answer exactly one list with
 * one slot per key asked, or the whole read throws UnknownReplyError.
 */
async function readMany(keys: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const asked = keys.slice(i, i + 100);
    const replies = repliesFor(await redisPipeline([["MGET", ...asked]]), 1);
    const values = replies ? repliesFor(replies[0], asked.length) : null;
    if (!values) throw new UnknownReplyError("a batch of description reads");
    out.push(...values);
  }
  return out;
}

/** The long descriptions of many products, in their order, a hundred at a command; throws like readAbout when any answer is unknown. */
export async function readAbouts(statsId: string | null, productIds: string[]): Promise<string[]> {
  if (!statsId || !isRedisConfigured()) return productIds.map(() => "");
  return (await readMany(productIds.map((id) => aboutKey(statsId, id)))).map(aboutOf);
}

/**
 * Writes a description, or forgets it when it is empty, after taking its
 * room in the store's data room (DataRoomError when it does not fit).
 */
export async function writeAbout(statsId: string, productId: string, text: string, room: DataStore, always = false): Promise<void> {
  const changes = [{ slot: `ab:${productId}`, bytes: text ? dataBytes([text], 1) : 0, set: true }];
  if (always) await noteData(room, changes);
  else await needData(room, changes);
  await redisPipeline([text ? ["SET", aboutKey(statsId, productId), text] : ["DEL", aboutKey(statsId, productId)]]);
}

/**
 * Writes `text` over the description only while it still reads `expected`
 * ("" for none), in one step: {1} when written, {0, the length it holds now}
 * when it changed meanwhile and nothing was written. Modelled by
 * lib/redis-memory.ts.
 */
export const WRITE_ABOUT_IF = `-- marktmorgen:about-write-if:v1
local now = redis.call('GET', KEYS[1]) or ''
if now ~= ARGV[1] then return {0, string.len(now)} end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2]) end
return {1}`;

/**
 * A description written only over the one it was read as (an agent's
 * proposal confirmed or undone, lib/agent-kinds.ts): true when written,
 * "changed" when someone changed it since and nothing was written (Codex G
 * on #1929). Its room moves by the difference: taken first when it grows,
 * given back once a smaller one is written, and this step's own taking
 * given back on "changed". An answer that is neither keeps what was taken
 * and throws.
 */
export async function writeAboutIf(statsId: string, productId: string, expected: string, text: string, room: DataStore): Promise<true | "changed"> {
  const weight = (t: string) => (t ? dataBytes([t], 1) : 0);
  const grown = weight(text) - weight(expected);
  const slot = `ab:${productId}`;
  if (grown > 0) await needData(room, [{ slot, bytes: grown }]);
  const reply: unknown = await redisPipeline([["EVAL", WRITE_ABOUT_IF, 1, aboutKey(statsId, productId), expected, text]]);
  const answer = Array.isArray(reply) && reply.length === 1 && Array.isArray(reply[0]) ? (reply[0] as unknown[]) : null;
  if (answer && answer.length === 1 && answer[0] === 1) {
    if (grown < 0) await giveData(room, [{ slot, bytes: -grown }]);
    return true;
  }
  if (answer && answer.length === 2 && answer[0] === 0 && Number.isSafeInteger(answer[1]) && (answer[1] as number) >= 0) {
    // Another writer changed it since. Every other writer sets the slot to exactly what it wrote (writeAbout, set), so
    // the slot is left as it is (Codex G on #1856, twice): giving back this step's taking, or setting it from the length
    // read here, could count less than a writer kept a moment later. At most this step's own taking stays counted more,
    // until the next write sets it; never less than is kept.
    return "changed";
  }
  throw new Error("a description's write could not be confirmed");
}

/** Forgets the description of a product that is gone, and gives back its room. */
export async function dropAbout(statsId: string | null, productId: string, room: DataStore): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await redisPipeline([["DEL", aboutKey(statsId, productId)]]);
  await giveData(room, [{ slot: `ab:${productId}`, bytes: 0, set: true }]);
}

/** A run of text, or an address to link to. */
export type Piece = { text: string; href?: string };

/** One block of a description: a paragraph of lines, or a list of points. */
export type Block = { kind: "paragraph"; lines: Piece[][] } | { kind: "list"; items: Piece[][] };

/**
 * Finds the web addresses in a line and makes them links.
 *
 * Only https and http, only addresses written out in full, and the full stop
 * or bracket that ends a sentence is left outside the link. The address the
 * link goes to is exactly the text the reader sees, so a link can never say
 * one place and go to another.
 */
export function linkPieces(line: string): Piece[] {
  const pieces: Piece[] = [];
  const pattern = /\bhttps?:\/\/[^\s<>"]+/gi;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    let url = match[0];
    // Counted from the end in one pass: an anchored pattern would take time
    // growing with the square of a long run of these that stops short of it.
    let cut = 0;
    while (cut < url.length && ".,;:!?)]}'’".includes(url[url.length - 1 - cut])) cut += 1;
    if (cut) url = url.slice(0, url.length - cut);
    const start = match.index ?? 0;
    let valid = false;
    try {
      const parsed = new URL(url);
      valid = (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password;
    } catch {
      valid = false;
    }
    if (!valid) continue;
    if (start > last) pieces.push({ text: line.slice(last, start) });
    pieces.push({ text: url, href: url });
    last = start + url.length;
  }
  if (last < line.length) pieces.push({ text: line.slice(last) });
  return pieces;
}

/** Cuts a description into the blocks the product page draws. */
export function aboutBlocks(text: string, max = MAX_ABOUT_LENGTH): Block[] {
  const blocks: Block[] = [];
  for (const chunk of cleanAbout(text, max).split(/\n\s*\n/)) {
    const lines = chunk.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    let paragraph: Piece[][] = [];
    let list: Piece[][] = [];
    const flush = () => {
      if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph });
      if (list.length) blocks.push({ kind: "list", items: list });
      paragraph = [];
      list = [];
    };
    for (const line of lines) {
      const point = /^\s*(?:[-*•])\s+(.*)$/.exec(line);
      if (point) {
        if (paragraph.length) {
          blocks.push({ kind: "paragraph", lines: paragraph });
          paragraph = [];
        }
        list.push(linkPieces(point[1]));
      } else {
        if (list.length) {
          blocks.push({ kind: "list", items: list });
          list = [];
        }
        paragraph.push(linkPieces(line.trim()));
      }
    }
    flush();
  }
  return blocks;
}

/** The first sentence or so, for a search result or a shared link. */
export function aboutExcerpt(text: string, max = 160, length = MAX_ABOUT_LENGTH): string {
  const flat = cleanAbout(text, length).replace(/^\s*[-*•]\s+/gm, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20))}…`;
}
