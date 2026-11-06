/** Opt-in evidence only: actual catalogue writers/readers and sitemap, synthetic Redis replies. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { productWrites } from "@/lib/catalog";
import { sitemapXml, storeSitemap } from "@/lib/store-sitemap";
import { store as redis } from "./redis-stub";

redis.clear();
const catalogId = "a".repeat(32);
const fixture = (async () => {
  const owner = "sitemap-proof@example.test";
  assert.equal((await claimHandle(owner, "sitemapreplyproof", "Fictional map", "Synthetic evidence.")).ok, true);
  await ensureStatsId(owner);
  const first = await addProduct(owner, "Fictional first guide", "", "12", null);
  const second = await addProduct(owner, "Fictional second guide", "", "12", null);
  assert.ok(first.ok && second.ok);
  const shop = await storeForEmail(owner);
  assert.ok(shop);
  await redis.pipeline([...productWrites(catalogId, first.product), ...productWrites(catalogId, second.product)]);
  // Same published inventory; only its carried cards are removed to exercise the real external catalogue read.
  return { ...shop, catalog: { ...shop.catalog, id: catalogId, head: [], inline: null } };
})();

const listingReads = (commands: Parameters<typeof redis.pipeline>[0]) => commands.length === 2 && commands.every(c => c[0] === "GET" && String(c[1]).startsWith(`nl:catalog:${catalogId}:l:`));

test("healthy actual sitemap contains both published products and serializes them", async () => {
  const entries = await storeSitemap(await fixture);
  const xml = sitemapXml(entries);
  assert.equal(entries.filter(e => e.url.includes("/p/")).length, 2);
  assert.match(xml, /fictional-first-guide/);
  assert.match(xml, /fictional-second-guide/);
});

for (const mode of ["missing-envelope", "partial-envelope", "extra-envelope", "malformed-record"] as const) {
  test(`actual sitemap must not certify a complete map after ${mode}`, async context => {
    const shop = await fixture;
    const original = redis.pipeline;
    let intercepted = 0;
    redis.pipeline = async commands => {
      const reply = await original.call(redis, commands);
      if (!listingReads(commands)) return reply;
      intercepted += 1;
      if (mode === "missing-envelope") return [];
      if (mode === "partial-envelope") return reply.slice(0, 1);
      if (mode === "extra-envelope") return [...reply, null];
      return [reply[0], "{"];
    };
    try {
      await assert.rejects(async () => {
        const entries = await storeSitemap(shop);
        const xml = sitemapXml(entries);
        context.diagnostic(JSON.stringify({ mode, productUrls: entries.filter(e => e.url.includes("/p/")).map(e => e.url), validXmlEnvelope: xml.startsWith("<?xml") && xml.includes("</urlset>") }));
      }, "unknown catalogue became successful XML");
    } finally {
      redis.pipeline = original;
      assert.equal(intercepted, 1);
    }
  });
}

test("an explicitly absent product remains distinct from a missing reply slot", async () => {
  const shop = await fixture;
  const original = redis.pipeline;
  redis.pipeline = async commands => {
    const reply = await original.call(redis, commands);
    return listingReads(commands) ? [reply[0], null] : reply;
  };
  try {
    const entries = await storeSitemap(shop);
    assert.equal(entries.filter(e => e.url.includes("/p/")).length, 1);
  } finally { redis.pipeline = original; }
});

test("a thrown catalogue transport error already prevents a successful map", async () => {
  const shop = await fixture;
  const original = redis.pipeline;
  redis.pipeline = async commands => {
    if (listingReads(commands)) throw new Error("Synthetic catalogue transport failure");
    return original.call(redis, commands);
  };
  try { await assert.rejects(() => storeSitemap(shop), /Synthetic catalogue transport failure/); }
  finally { redis.pipeline = original; }
});
