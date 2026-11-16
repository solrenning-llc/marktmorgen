/**
 * C4-2630 unit B2 (the family of Codex T's proof 64b3a0a9, MEDIUM): the whole
 * export never writes "no page", "no description" or "no thank-you note" for a
 * product whose part could not be read. Before this, lib/store-export.ts caught
 * a failed read of the pages, descriptions or notes and wrote null or "" for
 * every product, the same as a product that has none, with nothing saying so.
 * The creator's own copy of the store then shows pages that were never empty
 * as empty. Synthetic data only: the in-memory database and a fictional store.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addProduct, claimHandle, ensureStatsId, setProductAbout, setProductPage, storeForEmail } from "@/lib/store";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { writeThanksNote } from "@/lib/thanks-note-store";
import { writeAbout } from "@/lib/product-about";
import { storeExport } from "@/lib/store-export";
import { store as redis } from "./redis-stub";

const OWNER = "page-copy-unknown@example.test";
const UNREAD = "could not be read just now. Download the file again in a few minutes.";

const fixture = (async () => {
  redis.clear();
  assert.equal((await claimHandle(OWNER, "pagecopyunknown", "Fictional pantry", "Synthetic evidence only.")).ok, true);
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Dinner Guide", "Thirty dinners.", "19", null);
  assert.ok(made.ok);
  const store = await storeForEmail(OWNER);
  assert.ok(store?.statsId);
  await writePage(store.statsId, made.product.id, parsePage({ blocks: [{ id: "hero0001", kind: "hero", headline: "Dinner in thirty minutes", sub: "", media: "none", video: null }] }), store, true);
  assert.ok((await setProductPage(OWNER, made.product.id, true)).ok);
  await writeAbout(store.statsId, made.product.id, "A fictional long description.", store, true);
  assert.ok((await setProductAbout(OWNER, made.product.id, true)).ok);
  const fresh = await storeForEmail(OWNER);
  assert.ok(fresh?.statsId);
  await writeThanksNote(fresh.statsId, made.product.id, { heading: "Thank you", body: "A fictional note.", video: null, button: null }, fresh);
  return { store: (await storeForEmail(OWNER))!, id: made.product.id };
})();

async function exported(failing: string | null): Promise<Record<string, unknown>> {
  const { store } = await fixture;
  const original = redis.pipeline;
  // A read of one part fails the way the network or an unknown reply fails it: the request throws.
  redis.pipeline = async (commands) => {
    if (failing && commands.some((c) => c[0] === "MGET" && String(c[1]).startsWith(failing))) throw new TypeError("fetch failed");
    return original(commands);
  };
  try {
    return JSON.parse(await new Response(storeExport(store, 1000)).text()) as Record<string, unknown>;
  } finally {
    redis.pipeline = original;
  }
}

const product = (file: Record<string, unknown>) => (file.products as Record<string, unknown>[])[0];

test("the healthy export keeps the page, the description and the note, and says nothing is missing", async () => {
  const file = await exported(null);
  const row = product(file);
  assert.equal(((row.page as { blocks: unknown[] }).blocks).length, 1);
  assert.equal(row.about, "A fictional long description.");
  assert.equal((row.thanks as { body: string }).body, "A fictional note.");
  for (const note of ["pagesNote", "aboutsNote", "thanksNote"]) assert.equal(file[note], undefined, note);
});

for (const [part, prefix, field, note, absent] of [
  ["pages", "nl:product:page:", "page", "pagesNote", null],
  ["descriptions", "nl:product:about:", "about", "aboutsNote", ""],
  ["thank-you notes", "nl:product:note:", "thanks", "thanksNote", null],
] as const) {
  test(`unreadable ${part}: the export says so, and does not certify an empty one`, async () => {
    const { id } = await fixture;
    const file = await exported(prefix);
    const row = product(file);
    // The product itself is still exported: one unread part does not lose the rest.
    assert.equal(row.product && (row.product as { id: string }).id, id);
    assert.equal(typeof file[note], "string", `${note} names the part that could not be read`);
    assert.ok(String(file[note]).endsWith(UNREAD));
    // What it holds is not written as "none": the field is left out rather than set to the empty value.
    assert.ok(!(field in row) || row[field] !== absent, `${field} is not written as ${JSON.stringify(absent)}`);
    assert.equal(field in row, false);
  });
}
