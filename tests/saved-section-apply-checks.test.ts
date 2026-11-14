/**
 * Putting a saved section's latest version on the pages that use it ("apply", app/api/store/saved-blocks/route.ts)
 * is a save of each of those pages, so it is held to what the page's own save refuses (app/api/store/page/route.ts,
 * app/api/store/site-page/route.ts): a part left ⟦like this⟧ for the creator to write is never put on a page
 * visitors see, what the Terms forbid is never put on a published product's page, and no page grows past what a
 * page holds. Before, "apply" wrote each page with none of those checks, so a section changed in the library reached
 * live pages that the editor's own save would have refused. A page it cannot take is passed over and said why; the
 * page is left exactly as it was, and the others still get the section.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { emptyBlock, type PageBlock } from "@/lib/sales-page";
import { blocksForPage } from "@/lib/saved-blocks";
import { readPage } from "@/lib/sales-page-store";
import { siteKey } from "@/lib/site-page-rules";
import { POST as sections } from "@/app/api/store/saved-blocks/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";
import { POST as productPage } from "@/app/api/store/page/route";
import { store as redis } from "./redis-stub";

const OWNER = "apply-checks@example.com";
const text = (body: string, heading = "About"): PageBlock => ({ ...(emptyBlock("text") as Extract<PageBlock, { kind: "text" }>), heading, body });
const hero = (): PageBlock => ({ ...emptyBlock("hero"), headline: "Hello" }) as PageBlock;

type Json = Record<string, unknown> & { ok: boolean; error?: string };

async function start() {
  redis.clear();
  await claimHandle(OWNER, "applychecks", "Apply checks", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const call = (route: (r: NextRequest) => Promise<Response>, path: string) => async (body: unknown) =>
    (await (await route(new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", headers, body: JSON.stringify(body) }))).json()) as Json;
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  return { statsId, send: call(sections, "/api/store/saved-blocks"), site: call(sitePage, "/api/store/site-page"), product: call(productPage, "/api/store/page") };
}

test("a part left for the creator to write is not put on a page visitors see", async () => {
  const { statsId, send, site } = await start();
  const saved = await send({ action: "save", name: "About me", blocks: [text("I teach bread.")] });
  assert.equal(saved.ok, true, saved.error);
  const section = saved.section as { id: string; blocks: PageBlock[] };
  const shown = (await site({ action: "add", title: "About" })) as Json & { id: string };
  const draft = (await site({ action: "add", title: "Draft" })) as Json & { id: string };
  for (const [page, hidden] of [[shown.id, false], [draft.id, true]] as const) {
    const result = await site({ action: "save", id: page, page: { blocks: [hero(), ...blocksForPage(section)], style: "plain", hidden } });
    assert.equal(result.ok, true, result.error);
  }
  const before = await readPage(statsId, siteKey(shown.id));
  const updated = await send({ action: "update", id: section.id, blocks: [text("I teach bread. ⟦Add one sentence about who you are⟧")] });
  assert.equal(updated.ok, true, updated.error);
  // Said before the creator picks the pages, with the same reason.
  const uses = new Map((updated.uses as { key: string; why: string }[]).map((u) => [u.key, u.why]));
  assert.match(uses.get(siteKey(shown.id)) ?? "", /⟦Add one sentence about who you are⟧/);
  assert.equal(uses.get(siteKey(draft.id)), "");
  const applied = (await send({ action: "apply", id: section.id, pages: [siteKey(shown.id), siteKey(draft.id)] })) as Json & { done: string[]; skipped: { key: string; why: string }[] };
  assert.equal(applied.ok, true, applied.error);
  assert.deepEqual(applied.done, [siteKey(draft.id)], "a hidden page may keep the part, as its own save allows");
  assert.deepEqual(applied.skipped.map((s) => s.key), [siteKey(shown.id)]);
  assert.match(applied.skipped[0].why, /⟦Add one sentence about who you are⟧/);
  assert.deepEqual(await readPage(statsId, siteKey(shown.id)), before, "the shown page is left exactly as it was");
});

test("what the Terms forbid is not put on a published product's page", async () => {
  const { statsId, send, product } = await start();
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  assert.ok(made.ok);
  const id = made.product.id;
  const saved = await send({ action: "save", name: "Promise", blocks: [text("A careful guide to baking.")] });
  assert.equal(saved.ok, true, saved.error);
  const section = saved.section as { id: string; blocks: PageBlock[] };
  const result = await product({ id, page: { blocks: [hero(), ...blocksForPage(section)] } });
  assert.equal(result.ok, true, result.error);
  const before = await readPage(statsId, id);
  assert.equal((await send({ action: "update", id: section.id, blocks: [text("Make easy money from home with this guide.")] })).ok, true);
  const applied = (await send({ action: "apply", id: section.id, pages: [id] })) as Json & { done: string[]; skipped: { key: string; why: string }[] };
  assert.equal(applied.ok, true, applied.error);
  assert.deepEqual(applied.done, []);
  assert.deepEqual(applied.skipped.map((s) => s.key), [id]);
  assert.deepEqual(await readPage(statsId, id), before);
});

test("no page grows past what a page holds", async () => {
  const { statsId, send, site } = await start();
  const saved = await send({ action: "save", name: "Long", blocks: [text("Short.")] });
  assert.equal(saved.ok, true, saved.error);
  const section = saved.section as { id: string; blocks: PageBlock[] };
  const page = (await site({ action: "add", title: "Long" })) as Json & { id: string };
  // Quotes are written twice as long in a saved page, so these fill one close to its limit.
  const full = Array.from({ length: 19 }, (_, n) => text('"'.repeat(3_000), `Part ${n + 1}`));
  const result = await site({ action: "save", id: page.id, page: { blocks: [hero(), ...full, ...blocksForPage(section)], style: "plain", hidden: true } });
  assert.equal(result.ok, true, result.error);
  const before = await readPage(statsId, siteKey(page.id));
  const grown = await send({ action: "update", id: section.id, blocks: Array.from({ length: 6 }, (_, n) => text('"'.repeat(3_000), `More ${n + 1}`)) });
  assert.equal(grown.ok, true, grown.error);
  const applied = (await send({ action: "apply", id: section.id, pages: [siteKey(page.id)] })) as Json & { done: string[]; skipped: { key: string }[] };
  assert.equal(applied.ok, true, applied.error);
  assert.deepEqual(applied.done, []);
  assert.deepEqual(applied.skipped.map((s) => s.key), [siteKey(page.id)]);
  assert.deepEqual(await readPage(statsId, siteKey(page.id)), before);
});
