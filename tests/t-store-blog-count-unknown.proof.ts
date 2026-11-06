import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { publishedTotal, savePost } from "@/lib/store-blog";
import { sitemapSize } from "@/lib/store-sitemap";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

redis.clear();
const owner = "blog-count-proof@example.test";
const fixture = (async () => {
  assert.equal((await claimHandle(owner, "blogcountproof", "Fictional blog", "Synthetic evidence only.")).ok, true);
  await ensureStatsId(owner);
  const store = await storeForEmail(owner);
  assert.ok(store?.statsId);
  for (const [index, title] of ["First fictional post", "Second fictional post"].entries()) {
    const saved = await savePost(store.statsId, null, { title, body: "Synthetic blog content.", product: null, draft: false }, () => (index + 1).toString(16).padStart(10, "0"), ROOM, 1000 + index);
    assert.equal(saved.ok, true);
  }
  return store;
})();

for (const [label, reply] of [
  ["null slot", [null]], ["empty string slot", [""]], ["boolean slot", [false]],
  ["empty array slot", [[]]], ["array with a count", [["2"]]], ["extra envelope slot", [2, 99]],
] as const) {
  test(`unknown ${label} cannot certify an empty or complete blog sitemap`, async () => {
    const store = await fixture;
    const original = redis.pipeline;
    redis.pipeline = async commands => commands.length === 1 && commands[0][0] === "ZCARD" ? [...reply] : original(commands);
    try {
      const count = await publishedTotal(store.statsId);
      const size = await sitemapSize(store);
      assert.deepEqual({ count, size }, { count: null, size: null });
    } finally { redis.pipeline = original; }
  });
}

test("the real stored two-post count and one sitemap page remain known", async () => {
  const store = await fixture;
  assert.equal(await publishedTotal(store.statsId), 2);
  assert.equal((await sitemapSize(store))?.postPages, 1);
});

for (const [label, reply] of [["known zero", [0]], ["missing envelope", []]] as const) {
  test(`${label} control`, async () => {
    const store = await fixture, original = redis.pipeline;
    redis.pipeline = async () => [...reply];
    try { assert.equal(await publishedTotal(store.statsId), label === "known zero" ? 0 : null); }
    finally { redis.pipeline = original; }
  });
}

test("a thrown read remains unknown", async () => {
  const store = await fixture, original = redis.pipeline;
  redis.pipeline = async () => { throw Error("Synthetic unreadable response"); };
  try { assert.equal(await publishedTotal(store.statsId), null); }
  finally { redis.pipeline = original; }
});
