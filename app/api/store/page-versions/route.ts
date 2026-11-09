import type { NextRequest } from "next/server";
import { productIdFor } from "@/lib/catalog";
import { jsonAccess } from "@/lib/studio-route";
import { keepPictures, picturePaths } from "@/lib/sales-page";
import { MAX_VERSION_BYTES, keptPageBytes, readPage, readVersionsMeasured, versionSizes } from "@/lib/sales-page-store";
import { PageReadMeter } from "@/lib/page-read-units";
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
 *
 * Up to MAX_VERSIONS versions are read, each kept at up to MAX_VERSION_BYTES
 * bytes, and, to bring one back, the page: what they weigh at the most (each
 * version measured in Redis and taken at MAX_VERSION_BYTES, or at what it
 * weighs when one kept before 9 November 2026 weighs more; the page measured)
 * is taken from the studio's requests before they are read, past this
 * request's own fifty kilobytes, and the answer before it is sent
 * (lib/page-read-units.ts). Sizes that do not come back read nothing
 * (page_unread).
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
  const n = params.get("n");
  if (n !== null && !/^\d$/.test(n)) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  const meter = new PageReadMeter(store);
  const sizes = await versionSizes(store.statsId, id).catch(() => null);
  if (sizes === null) return Response.json({ ok: false, error: "page_unread" }, { status: 503, headers });
  const count = sizes.length;
  if (n !== null && Number(n) >= count) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  let page = 0;
  try {
    if (n !== null) page = await keptPageBytes(store.statsId, id);
  } catch (error) {
    console.error("measuring a page before bringing back a version failed", error);
    return Response.json({ ok: false, error: "page_unread" }, { status: 503, headers });
  }
  // A version kept before versions were held to MAX_VERSION_BYTES in bytes is taken at what it weighs, before it is read.
  const most = sizes.reduce((sum, size) => sum + Math.max(size, MAX_VERSION_BYTES), 0);
  const refused = await meter.take(most + page);
  if (refused) return refused;
  try {
    const { versions, bytes } = await readVersionsMeasured(store.statsId, id);
    // Saved over again since they were measured (another tab): the rest is taken before anything is sent.
    const over = await meter.take(bytes - most);
    if (over) return over;
    if (n === null) {
      return meter.send(
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
    // Grown since it was measured (a save in another tab): the rest is taken before anything is sent.
    const grown = await meter.take(Buffer.byteLength(JSON.stringify(current), "utf8") - page);
    if (grown) return grown;
    const kept = new Set(picturePaths(current));
    const { page: brought, dropped } = keepPictures(version.page, kept);
    return meter.send({ ok: true, at: version.at, page: brought, dropped });
  } catch (error) {
    console.error("reading a page's earlier versions failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
