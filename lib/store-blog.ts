/**
 * A creator's blog (added 9 October 2026): posts on the store's own address,
 * /@store/blog, written in the studio. Kajabi has one; Stan and Hotmart do
 * not. A post is how a store gets found by search engines for what it
 * knows, and each can end on one of the store's products.
 *
 * A post is plain text, written as a product's long description is
 * (lib/product-about.ts): a blank line starts a paragraph, "- " a point in a
 * list, a written-out https address becomes a link — and a line starting
 * with "## " is a heading. No markup is ever read from it.
 *
 * Kept apart from the store's record, which every visit reads, and read only
 * on the blog's own pages:
 *
 *   nl:blog:meta:<statsId>   id → what a list shows: title, dates, excerpt, draft
 *   nl:blog:body:<statsId>   id → the post's words and the product it ends on
 *   nl:blog:pub:<statsId>    the published posts, newest first by when
 *
 * The list of a blog is two reads (which posts, then their lines); a post is
 * one. The store's record carries only how many are published
 * (lib/store.ts, posts), so the store page links to the blog without asking.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { types } from "node:util";
import { UnknownReplyError, countOf } from "@/lib/redis-reply";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { type Block, aboutBlocks, aboutExcerpt, cleanAbout } from "@/lib/product-about";
import { slugOf } from "@/lib/product-slug";

export const MAX_POSTS = 200;
export const MAX_POST_TITLE = 120;
export const MAX_POST_BODY = 20_000;
export const POSTS_PER_PAGE = 12;

const metaKey = (statsId: string) => `nl:blog:meta:${statsId}`;
const bodyKey = (statsId: string) => `nl:blog:body:${statsId}`;
const pubKey = (statsId: string) => `nl:blog:pub:${statsId}`;

const POST_ID = /^[0-9a-f]{10}$/;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** Local equivalent until the independently reviewed shared reply reader reaches main. */
function blogReplies(reply: unknown, size: number): unknown[] | null {
  try {
    if (types.isProxy(reply) || !Array.isArray(reply) || Object.getOwnPropertySymbols(reply).length) return null;
    if (Object.getOwnPropertyDescriptor(reply, "length")?.value !== size || Object.getOwnPropertyNames(reply).length !== size + 1) return null;
    const out: unknown[] = [];
    for (let i = 0; i < size; i++) {
      const field = Object.getOwnPropertyDescriptor(reply, String(i));
      if (!field || !Object.hasOwn(field, "value")) return null;
      out.push(field.value);
    }
    return out;
  } catch { return null; }
}

/** Each mutation changes at most one member; the last reply is the confirmed total. */
function confirmedMutation(reply: unknown): { total: number | null } | null {
  const values = blogReplies(reply, 4);
  if (!values || values.slice(0, 3).some((value) => value !== 0 && value !== 1)) return null;
  return { total: countOf(values[3]) };
}

/** The write may have happened; callers must ask the creator to check before repeating it. */
export class BlogWriteUnconfirmed extends Error {
 constructor() { super("The blog change could not be confirmed"); this.name = "BlogWriteUnconfirmed"; }
}

/** The deletion is confirmed; only its resulting published count is unavailable. */
export class BlogCountUnavailable extends Error {
 constructor() { super("The blog count could not be confirmed"); this.name = "BlogCountUnavailable"; }
}

export type PostMeta = {
  id: string;
  title: string;
  excerpt: string;
  /** Not on the blog yet: only the studio shows it. */
  draft: boolean;
  /** When it was first published, in seconds; 0 for a draft never published. */
  publishedAt: number;
  updatedAt: number;
  /** About how many minutes it takes to read, at 220 words a minute. */
  minutes: number;
};

export type Post = PostMeta & { body: string; product: string | null };

/** What the studio sends, made safe to keep. */
export function cleanPost(raw: { title?: unknown; body?: unknown; product?: unknown; draft?: unknown }): { title: string; body: string; product: string | null; draft: boolean } {
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim().slice(0, MAX_POST_TITLE) : "";
  const body = typeof raw.body === "string" ? cleanAbout(raw.body, MAX_POST_BODY) : "";
  const product = typeof raw.product === "string" && PRODUCT_ID.test(raw.product) ? raw.product : null;
  return { title, body, product, draft: raw.draft === true };
}

/** A post's address: its title in words and its id at the end, as a product's (lib/product-slug.ts). */
export function postSegment(post: { id: string; title: string }): string {
  const words = slugOf(post.title);
  return words ? `${words}-${post.id}` : post.id;
}

/** The post an address names: its id, read off the end. */
export function postIdFrom(segment: string): string | null {
  const tail = segment.slice(-10);
  return POST_ID.test(tail) && (segment.length === 10 || segment[segment.length - 11] === "-") ? tail : null;
}

/** A post cut into what the page draws: headings, paragraphs and lists. */
export type PostBlock = Block | { kind: "heading"; text: string };

export function postBlocks(body: string): PostBlock[] {
  const out: PostBlock[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(...aboutBlocks(run.join("\n"), MAX_POST_BODY));
    run = [];
  };
  for (const line of cleanAbout(body, MAX_POST_BODY).split("\n")) {
    const heading = /^##\s+(.+)$/.exec(line.trim());
    if (heading) {
      flush();
      out.push({ kind: "heading", text: heading[1].trim().slice(0, 140) });
    } else {
      run.push(line);
    }
  }
  flush();
  return out;
}

function metaOf(id: string, input: { title: string; body: string; draft: boolean }, publishedAt: number, updatedAt: number): PostMeta {
  const plain = input.body.replace(/^##\s+/gm, "");
  const words = plain.split(/\s+/).filter(Boolean).length;
  return { id, title: input.title, excerpt: aboutExcerpt(plain, 200, MAX_POST_BODY), draft: input.draft, publishedAt, updatedAt, minutes: Math.max(1, Math.round(words / 220)) };
}

function parseMeta(raw: unknown): PostMeta | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<PostMeta>;
    if (typeof v.id !== "string" || !POST_ID.test(v.id) || typeof v.title !== "string") return null;
    // Stored visibility and dates are evidence, not values to coerce before publishing.
    // Date's range is narrower than the safe-integer range (these are seconds).
    const date = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000;
    if (typeof v.draft !== "boolean" || !date(v.publishedAt) || !date(v.updatedAt)) return null;
    return {
      id: v.id,
      title: v.title,
      excerpt: typeof v.excerpt === "string" ? v.excerpt : "",
      draft: v.draft,
      publishedAt: v.publishedAt,
      updatedAt: v.updatedAt,
      minutes: Math.max(1, Number(v.minutes) || 1),
    };
  } catch {
    return null;
  }
}

/** Every post of a store, drafts too, newest change first: for the studio. */
export async function allPosts(statsId: string | null): Promise<PostMeta[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HVALS", metaKey(statsId)]]);
  return (Array.isArray(raw) ? raw : [])
    .map(parseMeta)
    .filter((m): m is PostMeta => m !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One page of the published posts, newest first, and how many there are. */
export async function publishedPosts(statsId: string | null, page: number): Promise<{ posts: PostMeta[]; total: number }> {
  if (!statsId || !isRedisConfigured()) return { posts: [], total: 0 };
  const start = (Math.max(1, page) - 1) * POSTS_PER_PAGE;
  const reply = blogReplies(await redisPipeline([
    ["ZREVRANGE", pubKey(statsId), start, start + POSTS_PER_PAGE - 1],
    ["ZCARD", pubKey(statsId)],
  ]), 2);
  const ids = reply?.[0], total = reply ? countOf(reply[1]) : null;
  if (total === null || types.isProxy(ids) || !Array.isArray(ids)) throw new UnknownReplyError("a blog page count");
  const rawIds = blogReplies(ids, Math.min(POSTS_PER_PAGE, Math.max(0, total - start)));
  if (!rawIds || rawIds.some((id) => typeof id !== "string" || !POST_ID.test(id)) || new Set(rawIds).size !== rawIds.length) throw new UnknownReplyError("a blog page index");
  const list = rawIds as string[];
  if (list.length === 0) return { posts: [], total };
  const response = blogReplies(await redisPipeline([["HMGET", metaKey(statsId), ...list]]), 1);
  const metas = response ? blogReplies(response[0], list.length) : null;
  if (!metas) throw new UnknownReplyError("blog page metadata");
  const posts: PostMeta[] = [];
  for (const [i, raw] of metas.entries()) {
    const post = parseMeta(raw);
    if (!post || post.id !== list[i] || post.draft) throw new UnknownReplyError("a published blog post");
    posts.push(post);
  }
  return { posts, total };
}

/** How many posts are out, counted with one command; null when it cannot be counted (lib/store-sitemap.ts, sitemapSize). */
export async function publishedTotal(statsId: string | null): Promise<number | null> {
  if (!statsId) return 0;
  if (!isRedisConfigured()) return null;
  try {
    const reply = blogReplies(await redisPipeline([["ZCARD", pubKey(statsId)]]), 1);
    return reply ? countOf(reply[0]) : null;
  } catch {
    return null;
  }
}

/** One post, whole; null when there is none by that id. */
export async function readPost(statsId: string | null, id: string): Promise<Post | null> {
  if (!statsId || !isRedisConfigured() || !POST_ID.test(id)) return null;
  const [meta, body] = await redisPipeline([
    ["HGET", metaKey(statsId), id],
    ["HGET", bodyKey(statsId), id],
  ]);
  const m = parseMeta(meta);
  if (!m) return null;
  let words = "";
  let product: string | null = null;
  try {
    const parsed = JSON.parse(String(body)) as { body?: unknown; product?: unknown };
    words = typeof parsed.body === "string" ? parsed.body : "";
    product = typeof parsed.product === "string" && PRODUCT_ID.test(parsed.product) ? parsed.product : null;
  } catch {
    words = "";
  }
  return { ...m, body: words, product };
}

/** Every post whole, a hundred at a command for their words (HMGET): what a store's whole export reads (lib/store-export.ts). */
export async function readPosts(statsId: string | null, metas: PostMeta[]): Promise<Post[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const out: Post[] = [];
  for (let i = 0; i < metas.length; i += 100) {
    const some = metas.slice(i, i + 100);
    const [bodies] = await redisPipeline([["HMGET", bodyKey(statsId), ...some.map((m) => m.id)]]);
    some.forEach((m, n) => {
      let words = "";
      let product: string | null = null;
      try {
        const parsed = JSON.parse(String(Array.isArray(bodies) ? bodies[n] : "")) as { body?: unknown; product?: unknown };
        words = typeof parsed.body === "string" ? parsed.body : "";
        product = typeof parsed.product === "string" && PRODUCT_ID.test(parsed.product) ? parsed.product : null;
      } catch {
        words = "";
      }
      out.push({ ...m, body: words, product });
    });
  }
  return out;
}

export type SaveResult = { ok: true; post: Post; published: number | null } | { ok: false; reason: "title" | "body" | "full" | "unknown" | "unconfirmed" | "off" };

/**
 * Writes a post: a new one when `id` is null, else the one with that id. A
 * post first published keeps that date; one made a draft again leaves the
 * blog until it is published again. Says how many are published after it.
 */
export async function savePost(
  statsId: string | null,
  id: string | null,
  input: { title: string; body: string; product: string | null; draft: boolean },
  newId: () => string,
  /** The store whose data room the post takes from (DataRoomError when it does not fit). */
  room: DataStore,
  now = Math.floor(Date.now() / 1000),
): Promise<SaveResult> {
  if (!statsId || !isRedisConfigured()) return { ok: false, reason: "off" };
  if (!input.title) return { ok: false, reason: "title" };
  if (!input.body) return { ok: false, reason: "body" };
  let before: PostMeta | null = null;
  if (id) {
    const reply = blogReplies(await redisPipeline([["HGET", metaKey(statsId), id]]), 1);
    before = parseMeta(reply?.[0]);
    if (!before || before.id !== id) return { ok: false, reason: "unknown" };
  } else {
    const reply = blogReplies(await redisPipeline([["HLEN", metaKey(statsId)]]), 1);
    const count = reply ? countOf(reply[0]) : null;
    // Unlike GET, HLEN/ZCARD always answer an integer, including zero for an absent key.
    if (count === null) return { ok: false, reason: "unknown" };
    if (count >= MAX_POSTS) return { ok: false, reason: "full" };
  }
  const postId = before?.id ?? newId();
  const publishedAt = input.draft ? before?.publishedAt ?? 0 : before?.publishedAt || now;
  const meta = metaOf(postId, input, publishedAt, now);
  // Its room first: the post's two records and its place among the published, counted as it now is.
  const bodyJson = JSON.stringify({ body: input.body, product: input.product });
  await needData(room, [{ slot: `bl:${postId}`, bytes: dataBytes([JSON.stringify(meta), bodyJson], 3), set: true }]);
  const changed = confirmedMutation(await redisPipeline([
    ["HSET", metaKey(statsId), postId, JSON.stringify(meta)],
    ["HSET", bodyKey(statsId), postId, bodyJson],
    input.draft ? ["ZREM", pubKey(statsId), postId] : ["ZADD", pubKey(statsId), publishedAt, postId],
    ["ZCARD", pubKey(statsId)],
  ]));
  // The write may have happened: retain its room and report uncertainty, never a fabricated count.
  if (changed === null) return { ok: false, reason: "unconfirmed" };
  return { ok: true, post: { ...meta, body: input.body, product: input.product }, published: changed.total };
}

/** Removes a post for good. Says how many are published after it. */
export async function deletePost(statsId: string | null, id: string, room: DataStore): Promise<number | null> {
  if (!statsId || !isRedisConfigured() || !POST_ID.test(id)) return null;
  const changed = confirmedMutation(await redisPipeline([
    ["HDEL", metaKey(statsId), id],
    ["HDEL", bodyKey(statsId), id],
    ["ZREM", pubKey(statsId), id],
    ["ZCARD", pubKey(statsId)],
  ]));
  if (changed === null) throw new BlogWriteUnconfirmed();
  await giveData(room, [{ slot: `bl:${id}`, bytes: 0, set: true }]);
  if (changed.total === null) throw new BlogCountUnavailable();
  return changed.total;
}
