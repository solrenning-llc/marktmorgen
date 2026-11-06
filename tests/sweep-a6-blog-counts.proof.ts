/**
 * Proof (sweep A6, CX-123 rule 24/30): lib/store-blog.ts reads three counts
 * loosely while its sibling readers (allPosts, readPost, readPosts) are exact.
 *
 *   - savePost: HLEN in an unknown shape is read as 0, so the MAX_POSTS limit
 *     lets a 201st post be written;
 *   - savePost: ZCARD in an unknown shape is read as 0 published, which the
 *     route writes to the store record (setPostCount), hiding the blog link;
 *   - publishedPosts: an unknown ZREVRANGE/ZCARD is "no posts, total 0", and
 *     the public blog page answers 404 for a blog that has posts.
 *
 * The "defect" tests assert the fail-closed behavior and FAIL ON PURPOSE on
 * main; each "control" passes. Synthetic records and the in-memory Redis only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_POSTS, publishedPosts, savePost } from "@/lib/store-blog";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const sid = "synthetic-sweep-a6-blog";
let n = 0;
const nextId = () => String(++n).padStart(10, "0");
redis.clear();

const fill = (async () => {
  for (let i = 0; i < MAX_POSTS; i += 1) {
    const saved = await savePost(sid, null, { title: `Fictional post ${i}`, body: "Words.", product: null, draft: false }, nextId, ROOM, 1_000 + i);
    assert.equal(saved.ok, true);
  }
})();

/** Answers `wrong` to any pipeline that holds `command`; everything else as Redis would. */
async function withWrong<T>(command: string, wrong: (commands: (string | number)[][]) => unknown[], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => (commands.some((c) => c[0] === command) ? wrong(commands) : original.call(redis, commands))) as typeof redis.pipeline;
  try { return await run(); } finally { redis.pipeline = original; }
}

test("control: a full blog refuses the next post when HLEN answers", async () => {
  await fill;
  const over = await savePost(sid, null, { title: "One too many", body: "x", product: null, draft: false }, nextId, ROOM);
  assert.deepEqual(over, { ok: false, reason: "full" });
});

test("defect: an HLEN reply missing its slot must not let post 201 be written", async () => {
  await fill;
  const over = await withWrong("HLEN", () => [], () => savePost(sid, null, { title: "Written past the limit", body: "x", product: null, draft: false }, nextId, ROOM));
  const [count] = await redis.pipeline([["HLEN", `nl:blog:meta:${sid}`]]);
  assert.equal(over.ok, false, `expected a refusal; got ok=${over.ok}, the blog now holds ${count} posts (MAX_POSTS ${MAX_POSTS})`);
});

test("control: an edit says how many are published", async () => {
  await fill;
  const saved = await savePost(sid, "0000000001", { title: "Edited", body: "Edited.", product: null, draft: false }, nextId, ROOM, 9_000);
  assert.equal(saved.ok && saved.published > 0, true);
});

test("defect: a ZCARD reply of another shape must not be reported as 0 published (the route writes it to store.posts)", async () => {
  await fill;
  const saved = await withWrong("ZCARD", (commands) => commands.map((c) => (c[0] === "ZCARD" ? "not-a-count" : c[0] === "HSET" ? 0 : 1)), () =>
    savePost(sid, "0000000002", { title: "Edited again", body: "Edited.", product: null, draft: false }, nextId, ROOM, 9_100));
  assert.notDeepEqual(saved.ok ? saved.published : "refused", 0, "savePost answered published: 0 for a blog with 200+ published posts");
});

test("control: the public list reads the posts", async () => {
  await fill;
  const page = await publishedPosts(sid, 1);
  assert.equal(page.total > 0 && page.posts.length > 0, true);
});

test("defect: an unknown public read must not be 'no posts, total 0' (the page then answers 404)", async () => {
  await fill;
  const read = withWrong("ZCARD", () => [], () => publishedPosts(sid, 1));
  await assert.rejects(read, "publishedPosts resolved { posts: [], total: 0 } for a blog with posts");
});
