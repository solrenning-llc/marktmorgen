/**
 * Searching a community: its posts and the comments under them, the lessons of
 * the courses sold with it, its events, and the people in it.
 *
 * This is the one thing a community needs more of the longer it runs. A feed
 * answers "what is new"; nothing in a feed answers "has this been asked
 * before", and that question is the whole reason an archive is worth paying
 * for. Without it the same question is answered again every week, by hand, by
 * the creator.
 *
 * Why it reaches past posts, measured rather than assumed (checked 30 September
 * 2026): Skool searches posts, comments, course content and members from one
 * box. Circle searches posts, comments, lesson titles and bodies, members with
 * their profile fields, events and messages. Mighty Networks searches posts,
 * comments, coursework, members and events. Whop documents search only of its
 * marketplace and of direct messages. Stan documents no search at all. A
 * community here that could only find posts was behind three of the four that
 * document anything.
 *
 * How it is kept, all under the community's own id:
 *
 *   nl:cm:<id>:w:<token>    posts holding that word, scored by post number
 *   nl:cm:<id>:wi:<post>    the words that post is indexed under
 *   nl:cm:<id>:wl:<token>   lessons, scored by their place in the course
 *   nl:cm:<id>:wil:<lesson> the words that lesson is indexed under
 *   nl:cm:<id>:we:<token>   events, scored by when they start
 *   nl:cm:<id>:wie:<event>  the words that event is indexed under
 *   nl:cm:<id>:wm:<token>   members, scored by when they joined
 *   nl:cm:<id>:wim:<member> the words that member is indexed under
 *   nl:cm:<id>:q:<nonce>    one search's working set, gone within the minute
 *
 * Each kind is its own index and keeps its own order, and that is also how the
 * results are shown — four lists, not one pile sorted by a number that means a
 * post's place in one and an hour of the day in another. Posts keep the keys
 * they always had, so no store rebuilds an index that is already correct.
 *
 * A hit is a POST, never a comment on its own: the thread is what somebody is
 * looking for, and a comment away from its thread answers nothing. A post is
 * found by the words in its title, in its text, and in every comment under
 * it, so an answer given in the comments is findable by the words of the
 * answer.
 *
 * Scored by post number, which only ever grows, so results read newest first
 * and page exactly as the feed does — a page never repeats or skips while
 * somebody writes.
 *
 * Kept true by reindexing the whole post whenever anything in it changes. A
 * post's words are the union of its own and all its comments', so a deleted
 * comment cannot simply have its words removed — another comment may use the
 * same ones. Reading the post and its comments back is one GET and one
 * HGETALL, bounded by MAX_COMMENTS_PER_POST, and the difference against
 * `wi:<post>` is written. Correct beats clever here: an index that quietly
 * drifts out of step with the posts is worse than no index, because nobody
 * can tell it has.
 *
 * Two bounds worth knowing, both deliberate:
 *
 *   - At most MAX_INDEXED_WORDS distinct words per post are indexed. A post
 *     with 300 long comments under it can run past that; the words after it
 *     are not searchable. The cap is what keeps one community's index from
 *     growing without limit, and it is set high enough that ordinary writing
 *     never reaches it.
 *   - Words are matched whole, not by prefix. "pay" does not find "payment".
 *
 * Nothing here decides who may see what, and that matters more now than it did
 * with posts alone. The caller filters everything that comes back through the
 * same gates the pages themselves use: a space through the feed's gate, a
 * lesson through whether that address holds the product the course is sold
 * with, an event through mayAttend, a member through whether they asked to be
 * listed. Searching is not a way around a door, and a title is content — a
 * lesson called "The $40k month spreadsheet" tells somebody who has not bought it
 * something they did not pay for.
 */
import { redisPipeline } from "@/lib/redis";
import { MAX_COMMENTS_PER_POST } from "@/lib/community-text";

const base = (id: string) => `nl:cm:${id}`;

/**
 * What can be searched for. Each is indexed apart from the others and keeps
 * its own natural order, which is also how the results are shown: four lists,
 * not one pile sorted by a number that means something different in each.
 *
 * Verified against the field on 30 September 2026, so that what is built here
 * is measured rather than guessed: Skool searches posts, comments, course
 * content and members; Circle searches posts, comments, lesson titles and
 * bodies, members, events and messages; Mighty Networks searches posts,
 * comments, coursework, members and events; Whop documents search of its
 * marketplace and of direct messages, and of nothing else in a community;
 * Stan documents no search at all.
 */
export type SearchKind = "post" | "lesson" | "event" | "member";

/**
 * The letter each kind's keys carry. Posts have none, because posts were
 * indexed before there was more than one kind and their keys are already
 * written in every store that has a community. Changing them would mean
 * rebuilding an index that is correct, to no end.
 */
const MARK: Record<SearchKind, string> = { post: "", lesson: "l", event: "e", member: "m" };

const wordKey = (id: string, kind: SearchKind, word: string) => `${base(id)}:w${MARK[kind]}:${word}`;
const indexKey = (id: string, kind: SearchKind, thing: string) => `${base(id)}:wi${MARK[kind]}:${thing}`;

/** As many distinct words as one post and its comments may be indexed under. */
export const MAX_INDEXED_WORDS = 600;
/** Shorter than this and a word carries no meaning of its own. */
const MIN_WORD = 2;
/** Longer than this and it is a URL or a hash, not a word. */
const MAX_WORD = 24;
/** Words a query may hold: past this it is not a search. */
export const MAX_QUERY_WORDS = 8;
export const MAX_QUERY_LENGTH = 120;
/** How many posts one page of results holds. */
export const SEARCH_PAGE = 20;
/** How long a search's working set lives. Seconds. */
const WORK_SECONDS = 60;

/**
 * Words too common to narrow anything down. Kept short on purpose: a longer
 * list starts throwing away words people genuinely search for, and "how to"
 * is a real query.
 */
const SKIP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
  "i", "in", "is", "it", "its", "of", "on", "or", "that", "the", "this", "to", "was",
  "were", "will", "with", "you", "your",
]);

/**
 * Text as words to index or to search for: lower case, accents folded so
 * "café" and "cafe" are the same word, split on everything that is not a
 * letter or a number.
 */
export function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_WORD && word.length <= MAX_WORD && !SKIP.has(word));
}

/**
 * What one word a thing is found by is counted at in the store's data room
 * (lib/store-data.ts): its place in the word's sorted set and in the thing's
 * own set of words, rounded up.
 */
export const INDEX_WORD_BYTES = 96;

/** What indexing these parts can add, at the most: every distinct word, at INDEX_WORD_BYTES. */
export function indexBytes(parts: string[]): number {
  return distinct(parts).length * INDEX_WORD_BYTES;
}

/** The distinct words a post is found by, capped, in the order they appear. */
function distinct(parts: string[]): string[] {
  const seen = new Set<string>();
  for (const part of parts) {
    for (const word of words(part)) {
      seen.add(word);
      if (seen.size >= MAX_INDEXED_WORDS) return [...seen];
    }
  }
  return [...seen];
}

/**
 * Writes what a post is findable by. `parts` is its title, its text and the
 * text of every comment under it; `n` is its feed number, which orders the
 * results. Only the difference is written, so a comment that adds no new word
 * costs one read and no write.
 */
export async function index(
  id: string,
  kind: SearchKind,
  thing: string,
  score: number,
  parts: string[],
): Promise<void> {
  const next = distinct(parts);
  const [raw] = await redisPipeline([["SMEMBERS", indexKey(id, kind, thing)]]);
  const before = new Set(Array.isArray(raw) ? raw.map(String) : []);
  const after = new Set(next);
  const added = next.filter((word) => !before.has(word));
  const gone = [...before].filter((word) => !after.has(word));
  // The score can move on its own — an event put back an hour, a lesson
  // dragged up its module — so a thing whose words are unchanged still has to
  // have its place rewritten.
  const rescore = added.length === 0 && gone.length === 0 ? [...after] : [];
  if (!added.length && !gone.length && !rescore.length) return;
  await redisPipeline([
    ...added.map((word) => ["ZADD", wordKey(id, kind, word), score, thing]),
    ...rescore.map((word) => ["ZADD", wordKey(id, kind, word), score, thing]),
    ...gone.map((word) => ["ZREM", wordKey(id, kind, word), thing]),
    ...(added.length ? [["SADD", indexKey(id, kind, thing), ...added]] : []),
    ...(gone.length ? [["SREM", indexKey(id, kind, thing), ...gone]] : []),
  ]);
}

/** Takes something that is gone out of the index entirely. */
export async function unindex(id: string, kind: SearchKind, thing: string): Promise<void> {
  const [raw] = await redisPipeline([["SMEMBERS", indexKey(id, kind, thing)]]);
  const held = Array.isArray(raw) ? raw.map(String) : [];
  await redisPipeline([
    ...held.map((word) => ["ZREM", wordKey(id, kind, word), thing]),
    ["DEL", indexKey(id, kind, thing)],
  ]);
}

/**
 * Writes what a post is findable by. `parts` is its title, its text and the
 * text of every comment under it; `n` is its feed number, which orders the
 * results.
 */
export const indexPost = (id: string, post: string, n: number, parts: string[]) =>
  index(id, "post", post, n, parts);

/** Takes a deleted post out of the index entirely. */
export const unindexPost = (id: string, post: string) => unindex(id, "post", post);

/**
 * Whether a text holds every one of these words, as whole words.
 *
 * The same test the index applies, for the places searched by reading rather
 * than by index — the room, and a person's own messages — so a word finds the
 * same things everywhere it is typed.
 */
export function holdsAll(text: string, used: string[]): boolean {
  if (!used.length) return false;
  const has = new Set(words(text));
  return used.every((word) => has.has(word));
}

/** What a search is actually looking for: whole words, deduplicated, capped. */
export function queryWords(raw: string): string[] {
  return [...new Set(words(raw.slice(0, MAX_QUERY_LENGTH)))].slice(0, MAX_QUERY_WORDS);
}

export type SearchPage = {
  /** The ids found, in that kind's own order. */
  posts: string[];
  /** The number to ask for the next page with, or null at the end. */
  next: number | null;
  /** The words actually searched for, after the common ones were dropped. */
  used: string[];
  /**
   * How many match in all, not how many are on this page. The tabs show this,
   * and a tab reading "20" over two hundred matches is a number that means
   * nothing. It costs one ZCARD for a single word and nothing at all for
   * several, because ZINTERSTORE already answers with it.
   *
   * It is counted before the gate: some of these may be a lesson the searcher
   * has not bought or an event they may not attend, and the page says what it
   * can actually show rather than this number.
   */
  total: number;
};

const EMPTY: SearchPage = { posts: [], next: null, used: [], total: 0 };

/**
 * The posts holding every one of these words, newest first.
 *
 * `before` pages exactly as the feed does: the number of the last post on the
 * page just read. Asking for a page never repeats or skips a post, however
 * many are written while somebody reads the results.
 */
export async function search(
  id: string,
  raw: string,
  before: number | null = null,
  kind: SearchKind = "post",
): Promise<SearchPage> {
  const used = queryWords(raw);
  if (!used.length) return EMPTY;
  const max = before === null ? "+inf" : `(${before}`;
  // One word needs no working set: its own list is already the answer.
  if (used.length === 1) {
    const [rows, held] = await redisPipeline([
      ["ZREVRANGEBYSCORE", wordKey(id, kind, used[0]), max, "-inf", "WITHSCORES", "LIMIT", 0, SEARCH_PAGE],
      ["ZCARD", wordKey(id, kind, used[0])],
    ]);
    return { ...readPage(rows), used, total: Number(held) || 0 };
  }
  // Several words: every one of them has to be there. The working set is this
  // one search's alone and lets go of itself within the minute.
  // Web Crypto, so the course and community files the studio's editors share with the server bundle for the browser.
  const work = `${base(id)}:q:${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  try {
    const [count] = await redisPipeline([
      ["ZINTERSTORE", work, used.length, ...used.map((word) => wordKey(id, kind, word)), "AGGREGATE", "MAX"],
      ["EXPIRE", work, WORK_SECONDS],
    ]);
    if (!Number(count)) return { ...EMPTY, used };
    const [rows] = await redisPipeline([
      ["ZREVRANGEBYSCORE", work, max, "-inf", "WITHSCORES", "LIMIT", 0, SEARCH_PAGE],
    ]);
    // ZINTERSTORE answers with how many are in the set it just made, which is
    // the whole match count, so nothing extra is asked for it.
    return { ...readPage(rows), used, total: Number(count) || 0 };
  } finally {
    await redisPipeline([["DEL", work]]).catch(() => {});
  }
}

/** A Redis reply of member, score, member, score… as ids and the next cursor. */
function readPage(rows: unknown): { posts: string[]; next: number | null } {
  const flat = Array.isArray(rows) ? rows.map(String) : [];
  const posts: string[] = [];
  let last = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    posts.push(flat[i]);
    last = Number(flat[i + 1]) || last;
  }
  return { posts, next: posts.length === SEARCH_PAGE && last > 0 ? last : null };
}

/**
 * Every kind at once, each in its own list.
 *
 * Four searches, run together rather than one after another: they share
 * nothing, and a member waiting four round trips to be told which tab to press
 * would be a worse search than the narrow one this replaces.
 */
export async function searchEverything(
  id: string,
  raw: string,
  kinds: readonly SearchKind[] = ["post", "lesson", "event", "member"],
): Promise<Record<SearchKind, SearchPage>> {
  const done = await Promise.all(
    kinds.map((kind) => search(id, raw, null, kind).catch(() => ({ ...EMPTY }))),
  );
  const out: Record<SearchKind, SearchPage> = {
    post: { ...EMPTY },
    lesson: { ...EMPTY },
    event: { ...EMPTY },
    member: { ...EMPTY },
  };
  kinds.forEach((kind, at) => {
    out[kind] = done[at];
  });
  return out;
}

/** The text of a post and its comments, for indexing. Comments are bounded. */
export function partsOf(post: { title: string; text: string }, comments: { text: string }[]): string[] {
  return [post.title, post.text, ...comments.slice(0, MAX_COMMENTS_PER_POST).map((c) => c.text)];
}
