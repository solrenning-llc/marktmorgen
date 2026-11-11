import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { type Store, StoreFullError, appendSitePages, imageFolder, setSitePages, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { refusedJson } from "@/lib/studio-route";
import { lockedFor } from "@/lib/two-step";
import { EMPTY_PAGE, MAX_BLOCKS, emptyBlock, oversized, pageProblem, parsePage, picturePaths, type PageBlock, type SalesPage } from "@/lib/sales-page";
import { pageCopy } from "@/lib/site-page-copy";
import { claimNewPictures, dropPage, picturesOfFailedDrop, readPage, readPageExact, releasePictures, writePage } from "@/lib/sales-page-store";
import { del } from "@/lib/blob";
import { ownsImagePath } from "@/lib/product-image";
import { isStoredPicture } from "@/lib/picture-check";
import { hasPlaceholder } from "@/lib/mail-body";
import { MAX_SITE_PAGES, SITE_KINDS, SITE_PAGE_ID, SITE_STARTERS, type SitePage, outFrom, siteKey, siteTitle, slugFrom, slugProblem } from "@/lib/site-page-rules";

/** Thirty full blocks as JSON, with room to spare; a page is held to MAX_PAGE_BYTES. */
const MAX_BODY_BYTES = 200_000;

const refuse = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

/**
 * A new page made whole, or not at all (582 [KB3], copy and import): its blocks are written first, under the new
 * page's own key, which takes the store's room before anything is listed, so a store with no room for them refuses
 * with nothing added; only then is its place appended to the list under the store's lock. When the list refuses (a
 * newer list, the most pages, an address taken since), the blocks just written are taken back, so a refusal leaves the
 * store as it was. The page holds no picture (left out by copyOfPage), so there is none to claim or release.
 */
async function placeNewPage(ref: string, store: Store, entry: SitePage, page: SalesPage): Promise<{ ok: true; store: Store } | { ok: false; error: string; status: number }> {
  const statsId = store.statsId;
  const blocks = page.blocks.length > 0;
  if (blocks) {
    if (!statsId) return { ok: false, error: "copy_failed", status: 500 };
    try {
      await writePage(statsId, siteKey(entry.id), page, store);
    } catch (error) {
      if (error instanceof StoreFullError) return { ok: false, error: "copy_full", status: 409 };
      console.error("writing a new store page's blocks failed", error);
      await dropPage(statsId, siteKey(entry.id), store).catch((dropped: unknown) => console.error("taking back a new page's blocks failed", dropped));
      return { ok: false, error: "copy_failed", status: 500 };
    }
  }
  const takeBack = async () => {
    if (blocks && statsId) await dropPage(statsId, siteKey(entry.id), store).catch((error: unknown) => console.error("taking back a new page's blocks failed", error));
  };
  let saved: Awaited<ReturnType<typeof appendSitePages>>;
  try {
    saved = await appendSitePages(ref, [entry]);
  } catch (error) {
    console.error("listing a new store page failed", error);
    // The write may have been applied with only its answer lost (Codex U on #3531): the list is read again before
    // anything is taken back. Listed: the page was made. Confirmed not listed: the blocks are taken back, never left
    // unlisted. Not known: nothing is taken back, so a listed page never loses its blocks, and the creator is told.
    const now = await storeForEmail(ref).catch(() => null);
    if (now && now.sitePages.some((held) => held.id === entry.id)) return { ok: true, store: now };
    if (!now) return { ok: false, error: "copy_unknown", status: 503 };
    await takeBack();
    return { ok: false, error: "copy_failed", status: 500 };
  }
  if (!saved.ok) {
    await takeBack();
    return saved.reason === "none" ? { ok: false, error: "unknown", status: 404 } : { ok: false, error: "copy_conflict", status: 409 };
  }
  return { ok: true, store: saved.store };
}

/**
 * A store's own pages (lib/site-page-rules.ts): part of the public page, so
 * what the "page" role may change (lib/team-roles.ts).
 *
 *   { action: "add", title, slug?, starter? }   a new page, empty or from a starter's blocks
 *   { action: "copy", id }                      a copy of one, kept back, without its pictures (lib/site-page-copy.ts)
 *   { action: "meta", id, title, slug, nav, target }
 *   { action: "order", ids }
 *   { action: "remove", id }                    the page, its blocks and the pictures only it showed
 *   { action: "save", id, page }                its blocks, held to the rules a product's page is
 *
 * Every answer but "save" is the store's pages as they now are.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, ref } = guarded;
  const store = guarded.store;
  const action = text(body.action, 10);
  const pages = store.sitePages;
  const id = text(body.id, 12);
  const found = pages.find((page) => page.id === id) ?? null;

  try {
    if (action === "add") {
      if (pages.length >= MAX_SITE_PAGES) return refuse("too_many");
      const starter = SITE_STARTERS.find((s) => s.slug === text(body.starter, 40)) ?? null;
      const title = siteTitle(body.title) || starter?.title || "";
      if (!title) return refuse("title");
      // The address asked for, or one made from the title, numbered if that one is taken.
      let slug = text(body.slug, 60) || starter?.slug || slugFrom(title);
      if (!text(body.slug, 60)) {
        const base = slug || "page";
        for (let n = 2; slugProblem(slug, pages) === "taken" && n < 50; n += 1) slug = `${base.slice(0, 36)}-${n}`;
      }
      const problem = slugProblem(slug, pages);
      if (problem) return refuse(problem);
      const page: SitePage = { id: randomBytes(5).toString("hex"), slug, title, nav: true, target: "", from: -1 };
      const saved = await setSitePages(ref, [...pages, page]);
      if (!saved.ok) return refuse(saved.reason);
      if (starter && saved.store.statsId) {
        const blocks: PageBlock[] = starter.kinds.map((kind) => emptyBlock(kind));
        const hero = blocks[0];
        if (hero?.kind === "hero") Object.assign(hero, { headline: title, media: "none" });
        await writePage(saved.store.statsId, siteKey(page.id), { ...parsePage({}), blocks, hidden: true }, saved.store);
      }
      return Response.json({ ok: true, pages: saved.store.sitePages, id: page.id });
    }

    if (action === "copy") {
      // 582 [KB3]: the same blocks and words on a new page, kept back from visitors and out of the menu.
      if (!found || !SITE_PAGE_ID.test(found.id)) return refuse("unknown", 404);
      if (pages.length >= MAX_SITE_PAGES) return refuse("too_many");
      // The original read exactly: an answer nobody can read is never copied as an empty page.
      let held = { ...EMPTY_PAGE, blocks: [] as PageBlock[] };
      if (store.statsId) {
        try {
          held = (await readPageExact(store.statsId, siteKey(found.id))).page ?? held;
        } catch (error) {
          console.error("reading a store page before copying it failed", error);
          return refuse("page_unread", 503);
        }
      }
      const made = pageCopy(found, held, pages, randomBytes(5).toString("hex"));
      if (!made) return refuse("taken");
      // A product its buttons led to that the store no longer has is not carried: the copy's buttons lead to the store.
      if (made.entry.target && !store.catalog.items.some((item) => item.id === made.entry.target)) made.entry.target = "";
      const placed = await placeNewPage(ref, store, made.entry, made.page);
      if (!placed.ok) return refuse(placed.error, placed.status);
      return Response.json({ ok: true, pages: placed.store.sitePages, id: made.entry.id, pictures: made.pictures });
    }

    if (action === "meta") {
      if (!found) return refuse("unknown", 404);
      const title = siteTitle(body.title);
      const slug = text(body.slug, 60);
      if (!title) return refuse("title");
      const problem = slugProblem(slug, pages, found.id);
      // A page keeps an address it already has, even one reserved since; only a new one is refused.
      if (problem && !(problem === "reserved" && slug === found.slug)) return refuse(problem);
      const next = pages.map((page) => (page.id === found.id ? { ...page, title, slug, nav: body.nav !== false, target: text(body.target, 40) } : page));
      const saved = await setSitePages(ref, next);
      return saved.ok ? Response.json({ ok: true, pages: saved.store.sitePages }) : refuse(saved.reason);
    }

    if (action === "order") {
      const ids = Array.isArray(body.ids) ? body.ids.map((x) => text(x, 12)) : [];
      if (ids.length !== pages.length || !pages.every((page) => ids.includes(page.id))) return refuse("unknown");
      const saved = await setSitePages(ref, ids.map((x) => pages.find((page) => page.id === x)));
      return saved.ok ? Response.json({ ok: true, pages: saved.store.sitePages }) : refuse(saved.reason);
    }

    if (action === "remove") {
      if (!found) return refuse("unknown", 404);
      const saved = await setSitePages(ref, pages.filter((page) => page.id !== found.id));
      if (!saved.ok) return refuse(saved.reason);
      const gone = await dropPage(saved.store.statsId, siteKey(found.id), saved.store).catch(picturesOfFailedDrop);
      if (gone.length) await del(gone).catch((error: unknown) => console.error("could not delete a removed page's pictures", error));
      return Response.json({ ok: true, pages: saved.store.sitePages });
    }

    if (action === "save") {
      if (!found || !SITE_PAGE_ID.test(found.id)) return refuse("unknown", 404);
      const raw = body.page && typeof body.page === "object" ? (body.page as Record<string, unknown>) : null;
      if (!raw) return refuse("invalid");
      if (Array.isArray(raw.blocks) && raw.blocks.length > MAX_BLOCKS) return refuse("too_many");
      // What a product's page tests (a second headline, a second version) and
      // shows after a sign-up has no place on a store's own page.
      const page = { ...parsePage({ ...raw, test: null, variant: null, next: null }), test: null, variant: null, next: null };
      const problem = pageProblem({ ...raw, variant: null }, page);
      if (problem) return refuse(problem);
      if (page.blocks.some((block) => !SITE_KINDS.includes(block.kind))) return refuse("kind");
      if (oversized(page)) return refuse("too_big");
      // A part left ⟦like this⟧ for the creator to write (lib/funnel-ai-rules.ts) is a
      // direction, never words shown to visitors: kept while hidden, refused once shown or scheduled.
      if (outFrom(page) !== -1 && hasPlaceholder(JSON.stringify(page.blocks))) return refuse("placeholder");
      if (!store.statsId) {
        // A store written before it had one is given its id with the list.
        const marked = await setSitePages(ref, pages);
        if (!marked.ok || !marked.store.statsId) return refuse("server_error", 500);
        store.statsId = marked.store.statsId;
      }
      const statsId = store.statsId;
      const key = siteKey(found.id);
      // Pictures: each new one a picture in this store's own folder, shown on no other page.
      // A page whose read is not known is never taken for an empty one: nothing is claimed, released or written from it.
      let held;
      try {
        held = await readPage(statsId, key);
      } catch (error) {
        console.error("reading a store page before saving it failed", error);
        return refuse("page_unread", 503);
      }
      const before = picturePaths(held);
      const shown = picturePaths(page);
      // A picture taken off the page is deleted for good: not from a session let in without its second step (lib/two-step.ts).
      if (before.some((path) => !shown.includes(path)) && (await lockedFor(request, "page", "replace"))) return refusedJson("locked");
      const fresh = shown.filter((path) => !before.includes(path));
      if (fresh.length) {
        const folder = await imageFolder(ref);
        for (const path of fresh) {
          if (!ownsImagePath(path, folder) || !(await isStoredPicture(path))) return refuse("pictures");
        }
        // Fresh from the picture door or already this page's, never a product's, a link's or another page's picture
        // from the shared folder (lib/sales-page-store.ts, claimNewPictures).
        if (!(await claimNewPictures(statsId, key, fresh))) return refuse("pictures");
      }
      await writePage(statsId, key, page, store);
      // When it is out, kept on the list so the menu reads nothing more (lib/site-page-rules.ts).
      const from = outFrom(page);
      if (from !== found.from) await setSitePages(ref, pages.map((p) => (p.id === found.id ? { ...p, from } : p)));
      const gone = await releasePictures(statsId, key, before.filter((path) => !shown.includes(path))).catch(() => [] as string[]);
      if (gone.length) await del(gone).catch((error: unknown) => console.error("could not delete pictures taken off a page", error));
      return Response.json({ ok: true, blocks: page.blocks.length, page });
    }

    return refuse("invalid");
  } catch (error) {
    if (error instanceof StoreFullError) return refuse("store_full", 409);
    console.error("changing a store's pages failed", error);
    return refuse("server_error", 500);
  }
}
