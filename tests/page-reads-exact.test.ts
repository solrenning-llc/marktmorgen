/**
 * A page read whose answer is not known is never an empty page (C4-20261106-2610-C6-153, unit A; CX-123 rule 24).
 *
 * The cases below are Codex T's proof (codex/t-own-page-unknown-proof 64b3a0a9, tests/t-own-page-unknown.proof.ts),
 * reproduced by Revisor 2 in cycle 143, kept here as a permanent test: the real writer and the real readers
 * (lib/sales-page-store.ts readPage, readPages), with only Redis's answer to the page read changed. Its cases on
 * the custom page and its metadata belong to the public consumers (unit B) and stay in T's proof until then.
 *
 *   - confirmed absence (GET null, MGET of nulls) is still the empty page of today;
 *   - any other shape (no reply, one too many, a slot that is not a text, a text that is not a page, a shorter
 *     batch) throws instead of inventing an empty page, and the kept records are not touched;
 *   - a transport failure still propagates.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimHandle, ensureStatsId, setSitePages, storeForEmail } from "@/lib/store";
import { readPage, readPages, writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { store as redis } from "./redis-stub";

const pageId = "aaaaaaaaaa";
const otherId = "bbbbbbbbbb";
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
  const observedKeys = [pageId, otherId].map((id) => ["GET", `nl:product:page:${shop.statsId}:${siteKey(id)}`]);
  const before = await original.call(redis, observedKeys);
  let intercepted = 0;
  redis.pipeline = async (commands) => {
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
  try {
    await task();
  } finally {
    redis.pipeline = original;
    assert.equal(intercepted, 1, "exactly the intended reader was intercepted");
    assert.deepEqual(await original.call(redis, observedKeys), before, "the written page records remain unchanged");
  }
}

test("healthy actual writer and readers preserve the published page", async () => {
  const { shop, page } = await fixture;
  assert.deepEqual(await readPage(shop.statsId, siteKey(pageId)), page);
  assert.deepEqual(await readPages(shop.statsId, [siteKey(pageId), siteKey(otherId)]), [page, page]);
});

for (const mode of ["missing-envelope", "extra-envelope", "wrong-slot", "malformed-json"] as const) {
  test(`single-page reader must not certify an empty page after ${mode}`, async () => {
    const { shop } = await fixture;
    await withReply(mode, async () => {
      await assert.rejects(() => readPage(shop.statsId, siteKey(pageId)), "unknown GET became an ordinary page");
    });
  });
}

for (const mode of ["missing-envelope", "extra-envelope", "wrong-slot", "malformed-json", "partial-batch"] as const) {
  test(`batch-page reader must reject ${mode} instead of inventing an empty page`, async () => {
    const { shop } = await fixture;
    await withReply(mode, async () => {
      await assert.rejects(() => readPages(shop.statsId, [siteKey(pageId), siteKey(otherId)]), "unknown MGET became a complete page array");
    });
  });
}

test("confirmed GET null and confirmed MGET nulls retain legitimate empty pages", async () => {
  const { shop } = await fixture;
  await withReply("confirmed-absence", async () => {
    assert.equal((await readPage(shop.statsId, siteKey(pageId))).blocks.length, 0);
  });
  await withReply("confirmed-absence", async () => {
    assert.deepEqual((await readPages(shop.statsId, [siteKey(pageId), siteKey(otherId)])).map((page) => page.blocks.length), [0, 0]);
  });
});

test("thrown transport failure propagates from both readers", async () => {
  const { shop } = await fixture;
  await withReply("transport", async () => {
    await assert.rejects(() => readPage(shop.statsId, siteKey(pageId)), /SYNTHETIC_PAGE_TRANSPORT/);
  });
  await withReply("transport", async () => {
    await assert.rejects(() => readPages(shop.statsId, [siteKey(pageId), siteKey(otherId)]), /SYNTHETIC_PAGE_TRANSPORT/);
  });
});
