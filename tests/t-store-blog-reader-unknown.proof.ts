import { strict as assert } from "node:assert";
import { test } from "node:test";
import { allPosts, publishedPosts, readPost, savePost } from "@/lib/store-blog";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const sid = "synthetic-blog-reader-proof", id = "0000000001";
redis.clear();
const fixture = (async () => {
  const saved = await savePost(sid, null, { title: "Fictional bread guide", body: "The complete fictional post.", product: null, draft: false }, () => id, ROOM, 1000);
  assert.equal(saved.ok, true);
  const [meta] = await redis.pipeline([["HGET", `nl:blog:meta:${sid}`, id]]);
  assert.equal(typeof meta, "string");
  return { meta };
})();

for (const [label, reply] of [["missing envelope", []], ["null result", [null]], ["malformed row", [["{"]]]] as const) {
  test(`studio list rejects ${label} rather than certifying no posts`, async () => {
    await fixture;
    const original = redis.pipeline;
    redis.pipeline = async () => [...reply];
    try { await assert.rejects(() => allPosts(sid)); }
    finally { redis.pipeline = original; }
  });
}

for (const mode of ["missing-index", "malformed-index", "missing-metadata"] as const) {
  test(`public list rejects ${mode} rather than certifying an empty known page`, async () => {
    await fixture;
    const original = redis.pipeline;
    redis.pipeline = async commands => {
      if (mode === "missing-index" && commands[0][0] === "ZREVRANGE") return [];
      if (mode === "malformed-index" && commands[0][0] === "ZREVRANGE") return [[false], 1];
      if (mode === "missing-metadata" && commands[0][0] === "HMGET") return [];
      return original(commands);
    };
    try { await assert.rejects(() => publishedPosts(sid, 1)); }
    finally { redis.pipeline = original; }
  });
}

for (const mode of ["missing-envelope", "invalid-meta", "missing-body-slot", "invalid-body"] as const) {
  test(`post reader rejects ${mode} rather than certifying absence or empty body`, async () => {
    const { meta } = await fixture;
    const original = redis.pipeline;
    redis.pipeline = async () => mode === "missing-envelope" ? [] : mode === "invalid-meta" ? ["{", null] : mode === "missing-body-slot" ? [meta] : [meta, "{"];
    try { await assert.rejects(() => readPost(sid, id)); }
    finally { redis.pipeline = original; }
  });
}

test("the original writers still produce a complete studio list, public list and post", async () => {
  await fixture;
  assert.equal((await allPosts(sid)).length, 1);
  const page = await publishedPosts(sid, 1);
  assert.equal(page.total, 1);
  assert.equal(page.posts[0]?.id, id);
  assert.equal((await readPost(sid, id))?.body, "The complete fictional post.");
});

test("confirmed empty lists and absent post remain legitimate", async () => {
  await fixture;
  assert.deepEqual(await allPosts("synthetic-empty-blog"), []);
  assert.deepEqual(await publishedPosts("synthetic-empty-blog", 1), { posts: [], total: 0 });
  assert.equal(await readPost(sid, "0000000002"), null);
});
