import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { jsonAccess } from "@/lib/studio-route";
import { can } from "@/lib/team-roles";
import { idsOfKind, readCards } from "@/lib/catalog";
import { templateLeft } from "@/lib/template-text";
import { SAVED_BLOCK_ID } from "@/lib/sales-page";
import { readPage, writePage } from "@/lib/sales-page-store";
import { SITE_KINDS, isSiteKey } from "@/lib/site-page-rules";
import { BLOCK_KINDS, type BlockKind } from "@/lib/sales-page";
import { type SavedSection, SECTION_WHY, newSectionId, readSectionInput, updateProblem, withSection } from "@/lib/saved-blocks";
import { dropSection, readSection, readSections, sectionUses, writeSection } from "@/lib/saved-block-store";
import { MONTH_USE_SECONDS, countUse, storeMonthKey } from "@/lib/funnel-share-store";
import { MAX_APPLY_PAGES, shareLimitsFor, monthOfUse } from "@/lib/funnel-share-rules";
import type { Store } from "@/lib/store";

const refuse = (error: string, status = 400, extra: Record<string, unknown> = {}) => Response.json({ ok: false, error, ...extra }, { status });

/**
 * A page read whose answer was not known (lib/sales-page-store.ts readPage throws): the whole request is refused
 * before anything is written or counted, never answered from an empty page that was not (lib/studio-messages.ts).
 */
class PageUnread extends Error {}
const unread = () => refuse("page_unread", 503);
async function heldPage(statsId: string, key: string) {
  try {
    return await readPage(statsId, key);
  } catch (error) {
    console.error("reading a page for a saved section failed", error);
    throw new PageUnread();
  }
}

/** The kinds a page may hold: a store's own page its own, a product's page anything but a form. */
const kindsFor = (key: string): readonly BlockKind[] => (isSiteKey(key) ? SITE_KINDS : BLOCK_KINDS.map((k) => k.kind).filter((kind) => kind !== "form"));

/** Whether this role may change the page under this key. */
const mayChange = (role: Parameters<typeof can>[0], key: string) => can(role, isSiteKey(key) ? "page" : "products");

/**
 * Whether visitors see the page under this key, or will by themselves: a store's own page shown or scheduled (its
 * `from` on the store's list, written with its blocks), or the page of a product on the store. Read from the store
 * alone, so it is known before any page is read or the month's count is taken.
 */
function goesOut(store: Store, key: string): boolean {
  if (isSiteKey(key)) return (store.sitePages.find((p) => `site-${p.id}` === key)?.from ?? -1) !== -1;
  return store.catalog.items.some((item) => item.id === key) && !idsOfKind(store, "hidden").includes(key);
}

/** Why a section holding a part left to write cannot go on a page visitors see (754 [STN1], a sibling of #3593). */
const shownWhy = (part: string) => `Visitors see this page, and the section still has a part for you to write: “${part}”. Replace it with your own words first.`;

/** A page's key as this store has it, with its title, or null. */
function pageOf(store: Store, key: string, titles: Map<string, string>): { key: string; title: string; site: boolean } | null {
  if (isSiteKey(key)) {
    const page = store.sitePages.find((p) => `site-${p.id}` === key);
    return page ? { key, title: page.title, site: true } : null;
  }
  return store.catalog.items.some((item) => item.id === key) ? { key, title: titles.get(key) ?? "A product's page", site: false } : null;
}

/**
 * The pages that use a section, each with whether it can be updated from it
 * now and why not. `except` is the page being edited, which its editor saves.
 */
async function usesOf(store: Store, section: SavedSection, except = ""): Promise<{ key: string; title: string; site: boolean; why: string }[]> {
  const statsId = store.statsId!;
  const keys = (await sectionUses(statsId, section.id)).filter((key) => key !== except).slice(0, MAX_APPLY_PAGES * 2);
  const titles = new Map([...(await readCards(store)).values()].map((card) => [card.id, card.title]));
  const out: { key: string; title: string; site: boolean; why: string }[] = [];
  const left = templateLeft({ blocks: section.blocks });
  for (const key of keys) {
    const page = pageOf(store, key, titles);
    if (!page) continue;
    const held = await heldPage(statsId, key);
    const problem = updateProblem(held, section.id);
    if (problem === "gone") continue;
    const fits = problem === null && withSection(held, section, kindsFor(key)) !== null;
    out.push({ ...page, why: problem ? SECTION_WHY[problem] : left && goesOut(store, key) ? shownWhy(left.part) : fits ? "" : "The section no longer fits on this page." });
  }
  return out;
}

/**
 * The store's saved sections (lib/saved-blocks.ts), with the pages that use
 * each: `?section=<id>&except=<page key>` for one section's pages.
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "page");
  if (access instanceof Response) return access;
  const store = access.store;
  if (!store?.statsId) return refuse("unavailable", 503);
  const headers = { "Cache-Control": "private, no-store" };
  const limits = shareLimitsFor(store);
  try {
    const one = request.nextUrl.searchParams.get("section");
    if (one !== null) {
      if (!SAVED_BLOCK_ID.test(one)) return refuse("unknown", 404);
      const section = await readSection(store.statsId, one);
      if (!section) return refuse("unknown", 404);
      const except = (request.nextUrl.searchParams.get("except") ?? "").slice(0, 40);
      return Response.json({ ok: true, uses: await usesOf(store, section, except) }, { headers });
    }
    const sections = await readSections(store.statsId);
    return Response.json({ ok: true, sections, limit: limits.savedBlocks }, { headers });
  } catch (error) {
    if (error instanceof PageUnread) return unread();
    console.error("reading saved sections failed", error);
    return refuse("server_error", 500);
  }
}

/**
 *   { action: "save", name, blocks }           a new section in the library, from blocks of a page
 *   { action: "update", id, name?, blocks }    the section changed; answers with the other pages using it
 *   { action: "apply", id, pages: [key] }      those pages get the section as it is now
 *   { action: "remove", id }                   out of the library; pages keep their blocks
 *
 * Putting a section on a page is the page editor's own save.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", 60_000);
  if (!guarded.ok) return guarded.response;
  const { store, body, role } = guarded;
  if (!store.statsId) return refuse("unavailable", 503);
  const statsId = store.statsId;
  const limits = shareLimitsFor(store);
  const action = text(body.action, 10);
  const id = text(body.id, 10);
  const now = Math.floor(Date.now() / 1000);

  try {
    if (action === "save" || action === "update") {
      const existing = action === "update" ? (SAVED_BLOCK_ID.test(id) ? await readSection(statsId, id) : null) : null;
      if (action === "update" && !existing) return refuse("unknown", 404);
      const read = readSectionInput(body.name ?? existing?.name, body.blocks);
      if (!read.ok) return refuse(read.error);
      const section: SavedSection = { id: existing?.id ?? newSectionId(), name: read.name, blocks: read.blocks, updatedAt: now };
      // The pages that use it are read before the section is written, so an unknown page read changes nothing.
      const uses = existing ? await usesOf(store, section, text(body.except, 40)) : [];
      const written = await writeSection(statsId, section, !existing, limits.savedBlocks);
      if (written === "full") return refuse("sections_full", 400, { limit: limits.savedBlocks });
      if (written === "gone") return refuse("unknown", 404);
      return Response.json({ ok: true, section, picturesLeft: read.picturesLeft, uses });
    }

    if (action === "apply") {
      if (!SAVED_BLOCK_ID.test(id)) return refuse("unknown", 404);
      const section = await readSection(statsId, id);
      if (!section) return refuse("unknown", 404);
      const asked = Array.isArray(body.pages) ? [...new Set(body.pages.map((key) => text(key, 40)))] : [];
      if (!asked.length || asked.length > MAX_APPLY_PAGES) return refuse("pages");
      const listed = new Set(await sectionUses(statsId, id));
      if (asked.some((key) => !listed.has(key))) return refuse("pages");
      if (asked.some((key) => !mayChange(role, key))) return refuse("forbidden", 403);
      // A part a template left to write never goes onto a page visitors see (754 [STN1], a sibling of #3593): the
      // whole request is refused, saying the part and those pages, before the month's count and before any read or write.
      const left = templateLeft({ blocks: section.blocks });
      const shown = left ? asked.filter((key) => goesOut(store, key)) : [];
      if (left && shown.length) return refuse("placeholder", 409, { ...left, pages: shown });
      const month = monthOfUse(store);
      if (!month) return refuse("unavailable", 503);
      // The month's count is taken first, as before, so a request past the figure reads no page at all (Codex Z on
      // #2830: those reads would be beyond what the request's studio unit covers). Then every page is read before any
      // is written, so an unknown read writes nothing; the try it counted is said in the answer (page_unread_counted).
      if (!(await countUse(storeMonthKey(statsId, "apply", month), limits.appliesPerMonth, MONTH_USE_SECONDS))) return refuse("applies_full", 429, { limit: limits.appliesPerMonth });
      const titles = new Map([...(await readCards(store)).values()].map((card) => [card.id, card.title]));
      const planned: { key: string; next: NonNullable<ReturnType<typeof withSection>> }[] = [];
      const skipped: { key: string; why: string }[] = [];
      for (const key of asked) {
        if (!pageOf(store, key, titles)) {
          skipped.push({ key, why: "This page is gone." });
          continue;
        }
        let held;
        try {
          held = await heldPage(statsId, key);
        } catch (error) {
          if (error instanceof PageUnread) return refuse("page_unread_counted", 503);
          throw error;
        }
        const problem = updateProblem(held, id);
        const next = problem ? null : withSection(held, section, kindsFor(key));
        if (!next) {
          skipped.push({ key, why: problem ? SECTION_WHY[problem] : "The section no longer fits on this page." });
          continue;
        }
        planned.push({ key, next });
      }
      const done: string[] = [];
      for (const { key, next } of planned) {
        // Kept like any save: the page as it was is the newest of its earlier versions, to bring back.
        await writePage(statsId, key, next, store);
        done.push(key);
      }
      return Response.json({ ok: true, done, skipped });
    }

    if (action === "remove") {
      if (!SAVED_BLOCK_ID.test(id)) return refuse("unknown", 404);
      return (await dropSection(statsId, id)) ? Response.json({ ok: true }) : refuse("unknown", 404);
    }

    return refuse("invalid");
  } catch (error) {
    if (error instanceof PageUnread) return unread();
    console.error("changing saved sections failed", error);
    return refuse("server_error", 500);
  }
}
