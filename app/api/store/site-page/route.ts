import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { StoreFullError, imageFolder, setSitePages } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { refusedJson } from "@/lib/studio-route";
import { lockedFor } from "@/lib/two-step";
import { MAX_BLOCKS, emptyBlock, oversized, pageProblem, parsePage, picturePaths, type PageBlock } from "@/lib/sales-page";
import { claimNewPictures, dropPage, picturesOfFailedDrop, readPage, releasePictures, writePage } from "@/lib/sales-page-store";
import { del } from "@/lib/blob";
import { ownsImagePath } from "@/lib/product-image";
import { isStoredPicture } from "@/lib/picture-check";
import { templateLeft } from "@/lib/template-text";
import { MAX_SITE_PAGES, SITE_KINDS, SITE_PAGE_ID, SITE_STARTERS, type SitePage, outFrom, siteKey, siteTitle, slugFrom, slugProblem } from "@/lib/site-page-rules";

/** Thirty full blocks as JSON, with room to spare; a page is held to MAX_PAGE_BYTES. */
const MAX_BODY_BYTES = 200_000;

const refuse = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

/**
 * A store's own pages (lib/site-page-rules.ts): part of the public page, so
 * what the "page" role may change (lib/team-roles.ts).
 *
 *   { action: "add", title, slug?, starter? }   a new page, empty or from a starter's blocks
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
      // A part left ⟦like this⟧ for the creator to write (lib/funnel-ai-rules.ts), or a campaign's own part in
      // [brackets] (lib/funnel-starters.ts), is a direction, never words shown to visitors: kept while hidden,
      // refused once shown or scheduled, saying the block and the part (754 [STN1], unit 1).
      const left = outFrom(page) !== -1 ? templateLeft(page) : null;
      if (left) return Response.json({ ok: false, error: "placeholder", ...left }, { status: 400 });
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
