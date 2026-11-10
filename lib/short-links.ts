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
    if (!name || !target || typeof v.made !== "number" || !Number.isSafeInteger(v.made) || v.made < 0 || !v.sid || !v.statsId) return null;
    return { code: v.code, name, place: linkPlace(v.place), target, made: v.made, sid: v.sid, statsId: v.statsId };
  } catch {
    return null;
  }
}

const shown = ({ code, name, place, target, made }: Kept): ShortLink => ({ code, name, place, target, made });

async function one(command: (string | number)[]): Promise<unknown> {
  const replies = await redisPipeline([command]);
  if (!Array.isArray(replies) || replies.length !== 1) throw new Error("Short link response is incomplete");
  return replies[0];
}

/**
 * One stored record, read exactly: null when the key is confirmed absent, "unreadable" when a record is there but
 * this code cannot read it (a rule made stricter since it was written: a fact, not an unknown reply, and it never
 * becomes readable by asking again), and a throw for any reply that is not a record at all (rule 24).
 */
function record(raw: unknown): Kept | null | "unreadable" {
  if (raw === null) return null;
  if (typeof raw !== "string" || !raw) throw new Error("Short link record is unavailable");
  return parse(raw) ?? "unreadable";
}

const newestFirst = (list: Kept[]): ShortLink[] => [...list].sort((a, b) => b.made - a.made || a.code.localeCompare(b.code)).map(shown);

const confirmedCount = (raw: unknown) => raw === 0 || raw === 1;

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
  if (!statsId) return [];
  if (!isRedisConfigured()) throw new Error("Short link inventory is unavailable");
  const raw = await one(["HVALS", storeKey(statsId)]);
  if (!Array.isArray(raw)) throw new Error("Short link inventory is incomplete");
  const list: Kept[] = [];
  const codes = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const kept = record(raw[i]);
    if (kept === null) throw new Error("Short link inventory is invalid");
    // A record this code cannot read, another store's or a second one for the same code is left out of the list,
    // as the public link treats it as ended (Claude 5 on #2527): one old record never takes the list down.
    if (kept === "unreadable" || kept.statsId !== statsId || codes.has(kept.code)) continue;
    codes.add(kept.code); list.push(kept);
  }
  return newestFirst(list);
}

/** The link a code names, with its store, or null. */
export async function findLink(code: string): Promise<(ShortLink & { sid: string; statsId: string }) | null> {
  if (!CODE.test(code)) return null;
  if (!isRedisConfigured()) throw new Error("Short link is unavailable");
  const kept = record(await one(["GET", linkKey(code)]));
  // A record there that cannot be read, or that names another code, opens nothing: the link has ended.
  return kept === "unreadable" || kept?.code !== code ? null : kept;
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
    const got = await one(["SET", linkKey(code), JSON.stringify(kept), "NX"]).catch(() => undefined);
    if (got === null) continue;
    if (got !== "OK") return { ok: false, reason: "unavailable" };
    if (!confirmedCount(await one(["HSET", storeKey(store.statsId), code, JSON.stringify(kept)]))) throw new Error("Short link index write is unconfirmed");
    // Saved: a list that cannot be read again just after is the one read before with this link added, never a
    // "did not save" that would make the next try answer "taken" (Claude 5 on #2527, P5).
    const after = await readLinks(store.statsId).catch(() => null);
    return { ok: true, link: shown(kept), links: after ?? newestFirst([kept, ...links.map((l) => ({ ...l, sid: store.sid, statsId: store.statsId }))]) };
  }
  return { ok: false, reason: "unavailable" };
}

/** Changes where a link goes; the post it is in keeps working. */
export async function retarget(statsId: string, code: unknown, target: unknown, isProduct: (id: string) => boolean): Promise<ShortLink[] | null> {
  if (typeof code !== "string" || !CODE.test(code)) return null;
  const next = readTarget(target, isProduct);
  const kept = record(await one(["HGET", storeKey(statsId), code]));
  // A record that cannot be read is not changed: the list leaves it out and the public link has ended.
  if (!next || kept === null || kept === "unreadable" || kept.code !== code || kept.statsId !== statsId) return null;
  const changed = JSON.stringify({ ...kept, target: next });
  // XX: a link ended since it was read stays ended (Claude 5 on #2527, P1); the index line the same trip wrote
  // back is taken away again before saying so.
  const replies = await redisPipeline([["SET", linkKey(code), changed, "XX"], ["HSET", storeKey(statsId), code, changed]]);
  if (!Array.isArray(replies) || replies.length !== 2 || !confirmedCount(replies[1])) throw new Error("Short link change is unconfirmed");
  if (replies[0] === null) {
    if (!confirmedCount(await one(["HDEL", storeKey(statsId), code]))) throw new Error("Short link change is unconfirmed");
    throw new Error("Short link was ended while it was being changed");
  }
  if (replies[0] !== "OK") throw new Error("Short link change is unconfirmed");
  return readLinks(statsId);
}

/** Ends a link: from now on it opens the page that says so. */
export async function removeLink(statsId: string, code: unknown): Promise<ShortLink[]> {
  if (typeof code === "string" && CODE.test(code)) {
    const kept = record(await one(["HGET", storeKey(statsId), code]));
    if (kept !== null) {
      // A line in this store's own list is this store's to end, whether or not it can be read (Claude 5 on
      // #2527, P2). Its public record goes with it unless that record is confirmed to be another store's.
      let ours = kept !== "unreadable" && kept.code === code && kept.statsId === statsId;
      if (!ours) {
        const open = record(await one(["GET", linkKey(code)]));
        ours = open === "unreadable" || (open !== null && open.statsId === statsId);
      }
      const commands: (string | number)[][] = [...(ours ? [["DEL", linkKey(code)]] : []), ["HDEL", storeKey(statsId), code]];
      const replies = await redisPipeline(commands);
      if (!Array.isArray(replies) || replies.length !== commands.length || !replies.every(confirmedCount)) throw new Error("Short link removal is unconfirmed");
    }
  }
  return readLinks(statsId);
}
