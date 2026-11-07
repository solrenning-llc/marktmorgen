/**
 * Short links for posts (added 13 October 2026): marktmorgen.com/l/<code>,
 * one for each post, video, talk or flyer, each with its own QR code, that
 * opens the store or one of its products already tagged with where it went
 * and the post's name. The studio then shows each link's visits, sales and
 * revenue on its line, and the creator can change where a link goes without
 * editing the post it is in.
 *
 * Read before it was built: Dub's links (a short address, its QR code, its
 * clicks and sales), Pirsch's and Umami's links, and DataFast's UTM guide.
 * Here a link adds nothing a visit does not already count: it sends the
 * person to the page with utm_source (where it was posted), utm_medium=post
 * and utm_campaign (the post's name), exactly as "A link for one post"
 * (lib/share-links.ts) does, so the visit, and the plan's count of visits
 * (lib/traffic.ts), are made by the page it lands on, and the results are
 * the numbers' own "Which post made you money" rows.
 *
 * Opening a link reads one record and answers with a redirect the CDN keeps
 * for five minutes, so a link in a viral post is mostly answered without
 * reaching the server; a change of where it goes is seen within those five
 * minutes.
 *
 *   nl:slink:<code>             the link: its store and where it goes
 *   nl:slink:store:<statsId>    hash: <code> → the same, the store's links
 *
 * A link may change where it goes on a date (510 [CK2] unit 1, `then`): read
 * from the same record, so opening it costs what it did. Every change to a
 * kept link is a compare-and-swap of both copies (SWAP_LINK), so a change made
 * meanwhile, a date or a page, is never written over.
 */
import { randomInt } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { CODE, CODE_LETTERS, MAX_LINKS, MIN_THEN_MS, type ShortLink, keptThen, linkName, linkPlace, readTarget, readThen, settledAt } from "@/lib/short-link-rules";

export { type LinkTarget, type LinkThen, type ShortLink, shortUrl, landingUrl } from "@/lib/short-link-rules";

const ALPHABET = CODE_LETTERS;

type Kept = ShortLink & { sid: string; statsId: string };

export const linkKey = (code: string) => `nl:slink:${code}`;
const storeKey = (statsId: string) => `nl:slink:store:${statsId}`;

function parse(raw: unknown): Kept | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Kept>;
    if (typeof v.code !== "string" || !CODE.test(v.code) || typeof v.sid !== "string" || typeof v.statsId !== "string") return null;
    const name = linkName(v.name);
    const target = readTarget(v.target, () => true);
    if (!name || !target) return null;
    const kept: Kept = { code: v.code, name, place: linkPlace(v.place), target, made: Number(v.made) || 0, sid: v.sid, statsId: v.statsId };
    if (v.then === undefined) return kept;
    // A date that cannot be read is not "no date": the link would go on opening a page it was meant to leave.
    const then = keptThen(v.then);
    return then ? { ...kept, then } : null;
  } catch {
    return null;
  }
}

const shown = ({ code, name, place, target, made, then }: Kept): ShortLink => (then ? { code, name, place, target, made, then } : { code, name, place, target, made });

/** How many short links a store has made, in one command: what the path's post-link missions count (lib/path-facts.ts). */
export async function countLinks(statsId: string | null): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [raw] = await redisPipeline([["HLEN", storeKey(statsId)]]);
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** A store's links, the newest first. */
export async function readLinks(statsId: string | null): Promise<ShortLink[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HVALS", storeKey(statsId)]]);
  const list = (Array.isArray(raw) ? (raw as unknown[]) : []).map(parse).filter((l): l is Kept => Boolean(l && l.statsId === statsId));
  return list.sort((a, b) => b.made - a.made || a.code.localeCompare(b.code)).map(shown);
}

/** The link a code names, with its store, or null. */
export async function findLink(code: string): Promise<(ShortLink & { sid: string; statsId: string }) | null> {
  if (!CODE.test(code) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", linkKey(code)]]);
  return parse(raw);
}

export type AddResult = { ok: true; link: ShortLink; links: ShortLink[] } | { ok: false; reason: "name" | "taken" | "target" | "full" | "unavailable" };

/** Makes a link for a post: a name of its own in this store, where it was posted, where it goes. */
export async function addLink(
  store: { sid: string; statsId: string },
  input: { name: unknown; place: unknown; target: unknown },
  isProduct: (id: string) => boolean,
  now = Date.now(),
): Promise<AddResult> {
  const name = linkName(input.name);
  if (!name) return { ok: false, reason: "name" };
  const target = readTarget(input.target, isProduct);
  if (!target) return { ok: false, reason: "target" };
  if (!isRedisConfigured()) return { ok: false, reason: "unavailable" };
  const links = await readLinks(store.statsId);
  if (links.length >= MAX_LINKS) return { ok: false, reason: "full" };
  // One link to a name: two would add their results together on one row.
  if (links.some((l) => l.name === name)) return { ok: false, reason: "taken" };
  for (let tries = 0; tries < 5; tries += 1) {
    // randomInt draws each letter evenly; a byte taken modulo 31 would favour the first eight.
    const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    const kept: Kept = { code, name, place: linkPlace(input.place), target, made: now, sid: store.sid, statsId: store.statsId };
    const [got] = await redisPipeline([["SET", linkKey(code), JSON.stringify(kept), "NX"]]);
    if (got === null) continue;
    await redisPipeline([["HSET", storeKey(store.statsId), code, JSON.stringify(kept)]]);
    return { ok: true, link: shown(kept), links: await readLinks(store.statsId) };
  }
  return { ok: false, reason: "unavailable" };
}

/**
 * Both copies of a kept link, written only while the store's copy is still
 * exactly `before`: 1 written, 0 changed or gone since it was read.
 * KEYS[1] the link, KEYS[2] the store's links; ARGV[1] the code, ARGV[2] the
 * record as read, ARGV[3] the record to write.
 */
const SWAP_LINK = `-- marktmorgen:short-link-swap:v1
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[3])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
return 1`;

/** Writes `after` over a link whose record is still `before`: "done", "changed" when it was not, "unknown" when the reply says neither. */
export async function swapLink(statsId: string, code: string, before: string, after: string): Promise<"done" | "changed" | "unknown"> {
  const [reply] = await redisPipeline([["EVAL", SWAP_LINK, 2, linkKey(code), storeKey(statsId), code, before, after]]);
  return reply === 1 ? "done" : reply === 0 ? "changed" : "unknown";
}

export type ChangeResult = { ok: true; links: ShortLink[] } | { ok: false; reason: "gone" | "when" | "target" | "same" | "changed" | "unavailable" };

/** The store's own record of a link, as kept and as read, or null when it is not this store's. */
async function keptOf(statsId: string, code: unknown): Promise<{ raw: string; kept: Kept } | null> {
  if (typeof code !== "string" || !CODE.test(code) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["HGET", storeKey(statsId), code]]);
  const kept = parse(raw);
  return typeof raw === "string" && kept && kept.statsId === statsId ? { raw, kept } : null;
}

/** Swaps a link for `next` and answers the list as it is after. */
async function change(statsId: string, raw: string, next: Kept): Promise<ChangeResult> {
  const swapped = await swapLink(statsId, next.code, raw, JSON.stringify(next));
  if (swapped === "changed") return { ok: false, reason: "changed" };
  if (swapped === "unknown") return { ok: false, reason: "unavailable" };
  return { ok: true, links: await readLinks(statsId) };
}

/**
 * Changes where a link goes now; the post it is in keeps working. Before its
 * date the date stays; after it the date is spent, so the page chosen is the
 * one the link opens (settledAt).
 */
export async function retarget(statsId: string, code: unknown, target: unknown, isProduct: (id: string) => boolean, now = Date.now()): Promise<ChangeResult> {
  const found = await keptOf(statsId, code);
  if (!found) return { ok: false, reason: "gone" };
  const next = readTarget(target, isProduct);
  if (!next) return { ok: false, reason: "target" };
  return change(statsId, found.raw, { ...settledAt(found.kept, now), target: next });
}

/**
 * 510 [CK2] unit 1: from a date on, the link opens another page of the store
 * (`then`, read by readThen against `now`), or, with null, no longer changes.
 * Never the page it opens now: that would change nothing. A date already
 * past is spent first (settledAt), so taking it back keeps the page the link
 * opens now, and a new date starts from that page.
 */
export async function setThen(statsId: string, code: unknown, then: unknown, isProduct: (id: string) => boolean, now = Date.now()): Promise<ChangeResult> {
  const found = await keptOf(statsId, code);
  if (!found) return { ok: false, reason: "gone" };
  const current = settledAt(found.kept, now);
  if (then === null) {
    const rest: Kept = { ...current };
    delete rest.then;
    return change(statsId, found.raw, rest);
  }
  const next = readThen(then, isProduct, now);
  // Which part is wrong, so the studio says the right thing: the date, or where it goes.
  if (!next) return { ok: false, reason: then && typeof then === "object" && readThen({ ...then, at: now + MIN_THEN_MS }, isProduct, now) ? "when" : "target" };
  if (JSON.stringify(next.target) === JSON.stringify(current.target)) return { ok: false, reason: "same" };
  return change(statsId, found.raw, { ...current, then: next });
}

/** Ends a link: from now on it opens the page that says so. */
export async function removeLink(statsId: string, code: unknown): Promise<ShortLink[]> {
  if (typeof code === "string" && CODE.test(code)) {
    const [raw] = await redisPipeline([["HGET", storeKey(statsId), code]]);
    if (parse(raw)?.statsId === statsId) await redisPipeline([["DEL", linkKey(code)], ["HDEL", storeKey(statsId), code]]);
  }
  return readLinks(statsId);
}
