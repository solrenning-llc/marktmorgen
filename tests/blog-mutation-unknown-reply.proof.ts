/**
 * CX-123 rule 24/30 proof (Claude 6, sweep of lib/[s-z]*.ts): lib/store-blog.ts's writers read an
 * unknown count as zero, and each count decides a write:
 *   1. savePost reads an unknown HLEN as 0 posts, so a post is written past MAX_POSTS;
 *   2. savePost and deletePost answer an unknown ZCARD as 0 published, which app/api/store/blog
 *      writes on the store's record (setPostCount), so the feed answers 404 and the blog link goes.
 * Synthetic records only, the in-memory Redis stand-in with one reply changed. Each test asserts
 * the exact behavior and fails on main today.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_POSTS, allPosts, deletePost, savePost } from "@/lib/store-blog";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const sid = "synthetic-blog-mutation-proof";
let n = 0;
const nextId = () => (n++).toString(16).padStart(10, "0");
const post = (title: string) => ({ title, body: "Synthetic words.", product: null, draft: false });

async function fixture(): Promise<string> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const saved = await savePost(sid, null, post("Fictional rye"), nextId, ROOM, 1_000);
  assert.ok(saved.ok);
  return saved.post.id;
}

/** Answers `shape` for every reply to `command`; everything else goes to the stand-in. */
async function withReply<T>(command: string, shape: unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    const replies = await original(commands);
    return commands.map((c, i) => (c[0] === command ? shape : replies[i]));
  };
  try { return await run(); } finally { redis.pipeline = original; }
}

test("control: the counts answer as written", async () => {
  const id = await fixture();
  const second = await savePost(sid, null, post("Fictional spelt"), nextId, ROOM, 2_000);
  assert.deepEqual(second.ok ? second.published : null, 2);
  assert.equal(await deletePost(sid, id, ROOM), 1);
});

for (const [label, shape] of [["a string", "many"], ["null", null], ["a list", [1]]] as [string, unknown][]) {
  test(`limit: the post count read as ${label} never lets a post past MAX_POSTS`, async () => {
    await fixture();
    for (let i = 1; i < MAX_POSTS; i += 1) await savePost(sid, null, { ...post(`Filler ${i}`), draft: true }, nextId, ROOM);
    assert.equal((await allPosts(sid)).length, MAX_POSTS);
    await withReply("HLEN", shape, () => savePost(sid, null, post("One too many"), nextId, ROOM)).catch(() => null);
    assert.equal((await allPosts(sid)).length, MAX_POSTS);
  });

  test(`count write: savePost never answers ${label} as 0 published`, async () => {
    await fixture();
    await assert.rejects(() => withReply("ZCARD", shape, () => savePost(sid, null, post("Fictional spelt"), nextId, ROOM)));
  });

  test(`count write: deletePost never answers ${label} as 0 published`, async () => {
    const id = await fixture();
    await savePost(sid, null, post("Fictional spelt"), nextId, ROOM);
    await assert.rejects(() => withReply("ZCARD", shape, () => deletePost(sid, id, ROOM)));
  });
}
