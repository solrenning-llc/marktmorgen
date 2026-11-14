/**
 * Naming somebody: @handle, and the handle that makes it mean one person.
 *
 * Stan has no mentions at all. Circle, Skool, Mighty Networks and Kajabi all
 * do, and every one of them leans on a username, because a display name does
 * not identify anybody — two people called Ana Silva are two people, and an
 * @Ana Silva that quietly picks one of them is worse than no mention.
 *
 * So each member takes a handle when they choose their name: the name folded
 * to lower case and joined by hyphens, with a number on the end if somebody
 * already holds it. They see it on their own page, and it is what others
 * type. The creator is always @creator, which cannot be taken.
 *
 * Kept under the community's own id:
 *
 *   nl:cm:<id>:h        handle -> member key
 *
 * A handle is claimed and released together with the name it came from, and a
 * member who has not chosen a name has none, so there is nothing to type at
 * them and no notification they never asked for.
 *
 * What is deliberately NOT here: matching by display name as well, "did you
 * mean" guessing, and mentioning everybody at once. The first two make a
 * mention land on somebody who was not meant; the third is the feature that
 * turns a community's notifications into something people switch off.
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { CREATOR } from "@/lib/community";

const handlesKey = (id: string) => `nl:cm:${id}:h`;

export const MAX_HANDLE = 32;
/** How many @ in one post or comment are acted on. */
export const MAX_MENTIONS = 10;

/** The creator's, always, in every community. Never claimable by a member. */
export const CREATOR_HANDLE = "creator";

/** What an @ may be followed by. */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;
/**
 * An @ counts only where a name could start: at the beginning, or after
 * something that is not part of a handle. Without that, the tail of an email
 * address written in a post — ana@example.com — reads as a mention of
 * @example.com, and one day somebody holds that handle and gets told about a
 * conversation they were never in.
 */
const FIND = /(?<![a-z0-9._-])@([a-z0-9][a-z0-9._-]{1,31})/gi;

/**
 * A name as a handle: accents folded, lower case, joined by hyphens. Empty
 * when nothing usable is left, which is what a name of only punctuation gives.
 */
export function slug(name: string): string {
  const made = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HANDLE);
  // It has to start with a letter or a number to be typeable after an @.
  const clean = made.replace(/^[^a-z0-9]+/, "");
  return clean.length >= 2 && clean !== CREATOR_HANDLE ? clean : "";
}

/**
 * Reserves a handle for this member. The one they had is NOT given up here:
 * their record still carries it until the change is known to be saved, so it
 * must keep resolving to them, and nobody else may take it, until then. The
 * caller gives it back once the record no longer carries it (setProfile in
 * lib/community.ts, rule 30 on Codex G's review 5815632734 of #3123).
 *
 * When the handle is taken, a number goes on the end and climbs until one is
 * free. Returns what they ended up with, or "" when the name gave nothing
 * usable — a member without a handle simply cannot be mentioned, which is a
 * smaller problem than a mention landing on a stranger.
 */
export async function claimHandle(id: string, who: string, name: string, had: string): Promise<string> {
  const wanted = slug(name);
  if (!wanted) return "";
  if (wanted === had) return had;
  for (let n = 0; n < 50; n += 1) {
    const tryThis = n === 0 ? wanted : `${wanted.slice(0, MAX_HANDLE - String(n + 1).length)}${n + 1}`;
    const [got] = await redisPipeline([["HSETNX", handlesKey(id), tryThis, who]]);
    if (Number(got) === 1) return tryThis;
    // Already ours: nothing to claim.
    const [owner] = await redisPipeline([["HGET", handlesKey(id), tryThis]]);
    if (owner === who) return tryThis;
  }
  return had;
}

/** Gives a handle back, for a member who is removed. */
export async function releaseHandle(id: string, handle: string): Promise<void> {
  if (handle) await redisPipeline([["HDEL", handlesKey(id), handle]]);
}

/** The handles written in a piece of text, lower case, in order, deduplicated. */
export function mentionsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(FIND)) {
    found.add(match[1].toLowerCase());
    if (found.size >= MAX_MENTIONS) break;
  }
  return [...found];
}

/**
 * Which of these handles belong to somebody, as handle -> member key. The
 * creator's own is answered without a lookup, so it works in a community
 * where nobody has chosen a name yet.
 */
export async function whoIs(id: string, handles: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const asked = handles.filter((h) => HANDLE_PATTERN.test(h));
  if (!asked.length) return found;
  const mine = asked.filter((h) => h !== CREATOR_HANDLE);
  if (asked.includes(CREATOR_HANDLE)) found.set(CREATOR_HANDLE, CREATOR);
  if (!mine.length) return found;
  const [rows] = await redisPipeline([["HMGET", handlesKey(id), ...mine]]);
  const list = Array.isArray(rows) ? rows : [];
  mine.forEach((handle, i) => {
    const key = list[i];
    if (typeof key === "string" && key) found.set(handle, key);
  });
  return found;
}

export type TextPart =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "mention"; text: string; handle: string };

/**
 * Splits already-segmented text again, so a handle inside a plain run becomes
 * its own part. Only handles that belong to somebody are marked: an @ that
 * names nobody stays exactly as it was written, because turning it into a
 * link would be the software inventing a person.
 */
export function withMentions(
  parts: { kind: "text" | "link"; text: string; href?: string }[],
  known: Map<string, string>,
): TextPart[] {
  const out: TextPart[] = [];
  for (const part of parts) {
    if (part.kind === "link") {
      out.push({ kind: "link", text: part.text, href: part.href ?? "" });
      continue;
    }
    let at = 0;
    for (const match of part.text.matchAll(FIND)) {
      const handle = match[1].toLowerCase();
      if (!known.has(handle)) continue;
      const start = match.index ?? 0;
      if (start > at) out.push({ kind: "text", text: part.text.slice(at, start) });
      out.push({ kind: "mention", text: match[0], handle });
      at = start + match[0].length;
    }
    if (at < part.text.length) out.push({ kind: "text", text: part.text.slice(at) });
  }
  return out;
}

/** Lets go of the handle a deleted member held, if it is still theirs (lib/community-erasure.ts). */
export async function forgetHandle(id: string, handle: string, who: string): Promise<number> {
  if (!handle) return 0;
  // Read exactly (rule 24): only an exact null or another member's id is "not theirs"; anything else throws, so the
  // erasure is tried again instead of leaving the handle pointing at the deleted member.
  const read = repliesFor(await redisPipeline([["HGET", handlesKey(id), handle]]), 1);
  const owner = read?.[0];
  if (!read || (owner !== null && typeof owner !== "string")) throw new UnknownReplyError("who holds a community handle");
  if (owner !== who) return 0;
  const gone = countOf(repliesFor(await redisPipeline([["HDEL", handlesKey(id), handle]]), 1)?.[0]);
  if (gone === null) throw new UnknownReplyError("a community handle let go");
  return gone;
}
