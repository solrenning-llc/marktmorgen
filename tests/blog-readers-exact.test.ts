import { strict as assert } from "node:assert";
import { test } from "node:test";
import { allPosts, publishedPosts, readPost, readPosts, savePost } from "@/lib/store-blog";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { storeExport } from "@/lib/store-export";
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

const validBody = JSON.stringify({ body: "The complete fictional post.", product: null });
for (const [label, reply] of [
  ["missing envelope", []], ["null slot", [null]], ["wrong slot", [{}]],
  ["short body list", [[]]], ["absent body record", [[null]]],
  ["malformed body JSON", [["{"]]],
  ["wrong body type", [[JSON.stringify({ body: 1, product: null })]]],
  ["extra envelope slot", [[validBody], 99]],
] as const) {
  test(`whole-post reader rejects ${label} rather than exporting invented empty words`, async () => {
    await fixture;
    const metas = await allPosts(sid), original = redis.pipeline;
    redis.pipeline = async () => [...reply];
    try { await assert.rejects(() => readPosts(sid, metas)); }
    finally { redis.pipeline = original; }
  });
}

test("whole-post reader preserves writer-produced words and a confirmed empty selection", async () => {
  await fixture;
  assert.equal((await readPosts(sid, await allPosts(sid)))[0]?.body, "The complete fictional post.");
  assert.deepEqual(await readPosts(sid, []), []);
});

const createExportFixture = async () => {
  const owner = "blog-reader-export@example.test";
  assert.equal((await claimHandle(owner, "blogreaderexport", "Fictional blog", "Synthetic evidence only.")).ok, true);
  await ensureStatsId(owner);
  const store = await storeForEmail(owner);
  assert.ok(store?.statsId);
  assert.equal((await savePost(store.statsId, null, { title: "Fictional bread guide", body: "The complete fictional post.", product: null, draft: false }, () => id, ROOM, 1000)).ok, true);
  return store;
};
let exportFixtureResult: ReturnType<typeof createExportFixture> | undefined;
const exportFixture = () => exportFixtureResult ??= createExportFixture();

for (const [label, reply] of [["missing envelope", []], ["absent body", [[null]]], ["invalid JSON", [["{"]]]] as const) {
  test(`the real export stream labels unread blog data for ${label}`, async () => {
    const store = await exportFixture(), original = redis.pipeline;
    redis.pipeline = async commands => commands[0]?.[0] === "HMGET" && commands[0]?.[1] === `nl:blog:body:${store.statsId}` ? [...reply] : original(commands);
    try {
      const exported = JSON.parse(await new Response(storeExport(store, 1000)).text());
      assert.equal(exported.posts, undefined);
      assert.equal(exported.unreadPart3, "This part could not be read just now. Download the file again in a few minutes.");
    } finally { redis.pipeline = original; }
  });
}

test("the real export stream preserves complete blog words on the healthy path", async () => {
  const store = await exportFixture();
  const exported = JSON.parse(await new Response(storeExport(store, 1000)).text());
  assert.equal(exported.posts[0]?.body, "The complete fictional post.");
  assert.equal(exported.unreadPart3, undefined);
});
