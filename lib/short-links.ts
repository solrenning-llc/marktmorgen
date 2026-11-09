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
 */
import { randomInt } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { CODE, CODE_LETTERS, MAX_LINKS, type ShortLink, linkName, linkPlace, readTarget } from "@/lib/short-link-rules";

export { type LinkTarget, type ShortLink, shortUrl, landingUrl } from "@/lib/short-link-rules";

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
    return { code: v.code, name, place: linkPlace(v.place), target, made: Number(v.made) || 0, sid: v.sid, statsId: v.statsId };
  } catch {
    return null;
  }
}

const shown = ({ code, name, place, target, made }: Kept): ShortLink => ({ code, name, place, target, made });

/** How many short links a store has made, in one command: what the path's post-link missions count (lib/path-facts.ts). */
export async function countLinks(statsId: string | null): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  // Read exactly (CX-123 rule 24): an answer in any other shape throws, so the path keeps its last reading, never 0 links.
  const [raw] = repliesFor(await redisPipeline([["HLEN", storeKey(statsId)]]), 1) ?? [undefined];
  const n = countOf(raw);
  if (n === null) throw new UnknownReplyError("a store's short links count");
  return n;
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

/** Changes where a link goes; the post it is in keeps working. */
export async function retarget(statsId: string, code: unknown, target: unknown, isProduct: (id: string) => boolean): Promise<ShortLink[] | null> {
  if (typeof code !== "string" || !CODE.test(code)) return null;
  const next = readTarget(target, isProduct);
  const [raw] = await redisPipeline([["HGET", storeKey(statsId), code]]);
  const kept = parse(raw);
  if (!next || !kept || kept.statsId !== statsId) return null;
  const changed = JSON.stringify({ ...kept, target: next });
  await redisPipeline([["SET", linkKey(code), changed], ["HSET", storeKey(statsId), code, changed]]);
  return readLinks(statsId);
}

/** Ends a link: from now on it opens the page that says so. */
export async function removeLink(statsId: string, code: unknown): Promise<ShortLink[]> {
  if (typeof code === "string" && CODE.test(code)) {
    const [raw] = await redisPipeline([["HGET", storeKey(statsId), code]]);
    if (parse(raw)?.statsId === statsId) await redisPipeline([["DEL", linkKey(code)], ["HDEL", storeKey(statsId), code]]);
  }
  return readLinks(statsId);
}
