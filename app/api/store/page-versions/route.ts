import type { NextRequest } from "next/server";
import { productIdFor } from "@/lib/catalog";
import { jsonAccess } from "@/lib/studio-route";
import { keepPictures, picturePaths } from "@/lib/sales-page";
import { readPage, readVersions } from "@/lib/sales-page-store";
import { isSiteKey } from "@/lib/site-page-rules";

/**
 * A product's page as it was before its last saves (lib/sales-page-store.ts,
 * readVersions), to bring one back in the studio's editor.
 *
 *   `?id=<product>`        -> each version: when it was saved over, how many blocks, its headline
 *   `?id=<product>&n=<i>`  -> that version, to load into the editor; nothing is saved here
 *
 * The same for one of the store's own pages, by `site-<page>` (lib/site-page-rules.ts).
 *
 * A version comes back with only the pictures the page still keeps: a
 * picture taken off the page was deleted when it was saved without it, and
 * the editor is told how many were left out.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const id = (params.get("id") ?? "").slice(0, 40);
  // A store's own page is part of the public page; a product's page, of the product.
  const site = isSiteKey(id);
  const access = await jsonAccess(request, site ? "page" : "products");
  if (access instanceof Response) return access;
  const store = access.store;
  const known = site ? store?.sitePages.some((page) => `site-${page.id}` === id) : store && productIdFor(store, id) === id;
  if (!store || !id || !known) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const versions = await readVersions(store.statsId, id);
    const n = params.get("n");
    if (n === null) {
      return Response.json(
        {
          ok: true,
          versions: versions.map((v, index) => ({
            index,
            at: v.at,
            blocks: v.page.blocks.length,
            headline: v.page.blocks[0]?.kind === "hero" ? v.page.blocks[0].headline : "",
            style: v.page.style,
          })),
        },
        { headers },
      );
    }
    const version = /^\d$/.test(n) ? versions[Number(n)] : undefined;
    if (!version) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    // The pictures the page shows now decide which of the version's are kept: never from an empty page that was not.
    let current;
    try {
      current = await readPage(store.statsId, id);
    } catch (error) {
      console.error("reading a page before bringing back a version failed", error);
      return Response.json({ ok: false, error: "page_unread" }, { status: 503, headers });
    }
    const kept = new Set(picturePaths(current));
    const { page, dropped } = keepPictures(version.page, kept);
    return Response.json({ ok: true, at: version.at, page, dropped }, { headers });
  } catch (error) {
    console.error("reading a page's earlier versions failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
