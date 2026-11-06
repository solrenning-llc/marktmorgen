/**
 * CX-123 rule 24 (Claude 6, sweep of lib/[s-z]*.ts): the public blog list (lib/store-blog.ts
 * publishedPosts, read by the blog page, its feed and the sitemap) reads each reply in its exact
 * shape. An unknown reply throws rather than reading as "no posts", which the blog page turns into a
 * 404 and the feed and sitemap into an empty list. A confirmed empty blog is still empty, and a post
 * listed with no record of its own is still left out. Synthetic records only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { publishedPosts, savePost } from "@/lib/store-blog";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const sid = "synthetic-public-blog-list";
let n = 0;
const nextId = () => (n++).toString(16).padStart(10, "0");

const fixture = (async () => {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  for (const title of ["Fictional rye", "Fictional spelt"]) {
    assert.equal((await savePost(sid, null, { title, body: "Synthetic words.", product: null, draft: false }, nextId, ROOM, 1_000 + n)).ok, true);
  }
})();

/** Answers `shape` for the reply at `slot` of the first pipeline whose first command is `command`. */
async function withReply<T>(command: string, slot: number, shape: unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    const replies = await original(commands);
    return commands[0]?.[0] === command ? replies.map((r, i) => (i === slot ? shape : r)) : replies;
  };
  try { return await run(); } finally { redis.pipeline = original; }
}

test("control: the written posts and the confirmed empty blog answer as they are", async () => {
  await fixture;
  const page = await publishedPosts(sid, 1);
  assert.deepEqual([page.total, page.posts.map((p) => p.title)], [2, ["Fictional spelt", "Fictional rye"]]);
  assert.deepEqual(await publishedPosts("synthetic-empty-public-blog", 1), { posts: [], total: 0 });
});

test("a listed post whose record is confirmed absent is left out, not unknown", async () => {
  await fixture;
  const page = await withReply("HMGET", 0, [null, null], () => publishedPosts(sid, 1));
  assert.deepEqual(page, { posts: [], total: 2 });
});

for (const [label, shape] of [["a number", 3], ["a string", "ids"], ["null", null], ["a list with a number", [5]]] as [string, unknown][]) {
  test(`the list of ids read as ${label} is unknown, never no posts`, async () => {
    await fixture;
    await assert.rejects(() => withReply("ZREVRANGE", 0, shape, () => publishedPosts(sid, 1)), UnknownReplyError);
  });
}

for (const [label, shape] of [["a string", "2"], ["null", null], ["a negative number", -1], ["a fraction", 1.5]] as [string, unknown][]) {
  test(`the count read as ${label} is unknown, never zero`, async () => {
    await fixture;
    await assert.rejects(() => withReply("ZREVRANGE", 1, shape, () => publishedPosts(sid, 1)), UnknownReplyError);
  });
}

for (const [label, shape] of [["a number", 1], ["a short list", [null]], ["broken JSON", ["{", "{"]], ["an object", [{}, {}]]] as [string, unknown][]) {
  test(`the posts' records read as ${label} are unknown, never left out`, async () => {
    await fixture;
    await assert.rejects(() => withReply("HMGET", 0, shape, () => publishedPosts(sid, 1)), UnknownReplyError);
  });
}

test("a missing reply envelope is unknown", async () => {
  await fixture;
  const original = redis.pipeline;
  redis.pipeline = async () => [];
  try { await assert.rejects(() => publishedPosts(sid, 1), UnknownReplyError); } finally { redis.pipeline = original; }
});
