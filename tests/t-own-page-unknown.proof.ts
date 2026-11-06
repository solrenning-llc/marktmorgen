/** Opt-in evidence: actual page writers/readers and page functions; synthetic Redis/request boundary. */
import assert from "node:assert/strict";
import { test } from "node:test";
import OwnPage, { generateMetadata } from "../app/[handle]/[slug]/page";
import { claimHandle, ensureStatsId, setSitePages, storeForEmail } from "@/lib/store";
import { readPage, readPages, writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { store as redis } from "./redis-stub";

const pageId = "aaaaaaaaaa";
const otherId = "bbbbbbbbbb";
const params = { params: Promise.resolve({ handle: "@ownpagereplyproof", slug: "about" }) };
redis.clear();
const fixture = (async () => {
  const owner = "own-page-proof@example.test";
  assert.equal((await claimHandle(owner, "ownpagereplyproof", "Fictional page store", "Synthetic evidence.")).ok, true);
  await ensureStatsId(owner);
  assert.equal((await setSitePages(owner, [{ id: pageId, slug: "about", title: "About", nav: true, target: "", from: 0 }])).ok, true);
  const shop = await storeForEmail(owner);
  assert.ok(shop?.statsId);
  const page = parsePage({ seoTitle: "Fictional published about page", blocks: [{ id: "text0001", kind: "text", heading: "About our fictional work", body: "Complete synthetic page words." }] });
  assert.equal(page.blocks.length, 1);
  await writePage(shop.statsId, siteKey(pageId), page, shop);
  await writePage(shop.statsId, siteKey(otherId), page, shop);
  return { shop, page };
})();

type Mode = "missing-envelope" | "extra-envelope" | "wrong-slot" | "malformed-json" | "partial-batch";
async function withReply(mode: Mode | "confirmed-absence" | "transport", task: () => Promise<void>): Promise<void> {
  const { shop } = await fixture;
  const original = redis.pipeline;
  const observedKeys = [pageId, otherId].map(id => ["GET", `nl:product:page:${shop.statsId}:${siteKey(id)}`]);
  const before = await original.call(redis, observedKeys);
  let intercepted = 0;
  redis.pipeline = async commands => {
    const reply = await original.call(redis, commands);
    const command = commands[0];
    if (commands.length !== 1 || !["GET", "MGET"].includes(String(command?.[0])) || !String(command?.[1]).startsWith(`nl:product:page:${shop.statsId}:`)) return reply;
    intercepted += 1;
    if (mode === "transport") throw new Error("SYNTHETIC_PAGE_TRANSPORT");
    if (mode === "missing-envelope") return [];
    if (mode === "extra-envelope") return [...reply, null];
    if (command[0] === "GET") return [mode === "confirmed-absence" ? null : mode === "malformed-json" ? "{" : false];
    if (mode === "partial-batch") return [(reply[0] as unknown[]).slice(0, 1)];
    return [mode === "confirmed-absence" ? [null, null] : mode === "malformed-json" ? ["{", (reply[0] as unknown[])[1]] : null];
  };
  try { await task(); }
  finally {
    redis.pipeline = original;
    assert.equal(intercepted, 1, "exactly the intended reader was intercepted");
    assert.deepEqual(await original.call(redis, observedKeys), before, "the written page records remain unchanged");
  }
}

test("healthy actual writer, reader and metadata preserve the published page", async () => {
  const { shop, page } = await fixture;
  assert.deepEqual(await readPage(shop.statsId, siteKey(pageId)), page);
  assert.deepEqual(await readPages(shop.statsId, [siteKey(pageId), siteKey(otherId)]), [page, page]);
  const metadata = await generateMetadata(params);
  assert.equal(metadata.title, page.seoTitle);
  assert.ok(metadata.alternates?.canonical);
});

for (const mode of ["missing-envelope", "extra-envelope", "wrong-slot", "malformed-json"] as const) {
  test(`single-page reader must not certify an empty page after ${mode}`, async context => {
    const { shop } = await fixture;
    await withReply(mode, async () => {
      await assert.rejects(async () => {
        const page = await readPage(shop.statsId, siteKey(pageId));
        context.diagnostic(JSON.stringify({ mode, blocks: page.blocks.length, seoTitle: page.seoTitle }));
      }, "unknown GET became an ordinary page");
    });
  });
}

for (const mode of ["missing-envelope", "extra-envelope", "wrong-slot", "malformed-json", "partial-batch"] as const) {
  test(`batch-page reader must reject ${mode} instead of inventing an empty page`, async context => {
    const { shop } = await fixture;
    await withReply(mode, async () => {
      await assert.rejects(async () => {
        const pages = await readPages(shop.statsId, [siteKey(pageId), siteKey(otherId)]);
        context.diagnostic(JSON.stringify({ mode, blockCounts: pages.map(page => page.blocks.length) }));
      }, "unknown MGET became a complete page array");
    });
  });
}

for (const mode of ["missing-envelope", "malformed-json", "transport"] as const) {
  test(`actual custom-page metadata must not say Not found after ${mode}`, async context => {
    await withReply(mode, async () => {
      // An unknown read may throw or produce explicitly unavailable metadata, never known absence.
      let title = "";
      try { title = String((await generateMetadata(params)).title); }
      catch (error) { assert.notEqual((error as Error).message, "SYNTHETIC_NOT_FOUND"); return; }
      context.diagnostic(JSON.stringify({ mode, title }));
      assert.doesNotMatch(title, /Not found/);
    });
  });
  test(`actual custom-page function must not invoke notFound after ${mode}`, async context => {
    await withReply(mode, async () => {
      let false404 = false;
      try { await OwnPage(params); }
      catch (error) { false404 = (error as Error).message === "SYNTHETIC_NOT_FOUND"; }
      context.diagnostic(JSON.stringify({ mode, false404 }));
      assert.equal(false404, false);
    });
  });
}

test("confirmed GET null and confirmed MGET nulls retain legitimate empty pages", async () => {
  const { shop } = await fixture;
  await withReply("confirmed-absence", async () => { assert.equal((await readPage(shop.statsId, siteKey(pageId))).blocks.length, 0); });
  await withReply("confirmed-absence", async () => { assert.deepEqual((await readPages(shop.statsId, [siteKey(pageId), siteKey(otherId)])).map(page => page.blocks.length), [0, 0]); });
});

test("confirmed absent custom page still follows the actual not-found path", async () => {
  await withReply("confirmed-absence", async () => { assert.match(String((await generateMetadata(params)).title), /Not found/); });
  await withReply("confirmed-absence", async () => { await assert.rejects(() => OwnPage(params), /SYNTHETIC_NOT_FOUND/); });
});

test("thrown transport failure already propagates from the direct single-page reader", async () => {
  const { shop } = await fixture;
  await withReply("transport", async () => { await assert.rejects(() => readPage(shop.statsId, siteKey(pageId)), /SYNTHETIC_PAGE_TRANSPORT/); });
});
