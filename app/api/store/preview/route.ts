import { takePublicRequest } from "@/lib/traffic";
import type { NextRequest } from "next/server";
import { readListing } from "@/lib/catalog";
import { normaliseHandle, setProductPreview, storeForHandle } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { plain, serveFile } from "@/lib/serve-file";
import { MAX_PREVIEW_PAGES, previewCopy } from "@/lib/pdf-preview";
import { clientAddress, withinEssentialLimit } from "@/lib/request-guard";

/** Making a preview the first time reads the whole PDF: give it the time a big one needs. */
export const maxDuration = 60;

/**
 * The first pages of a product's PDF, for anyone, before buying
 * (lib/pdf-preview.ts): `?handle=<store>&product=<id>`.
 *
 * Only for a product whose creator switched it on, only its first pages, and
 * counted as a free download, so it pauses with the store's other free
 * downloads rather than running up a bill (lib/serve-file.ts).
 */
export async function GET(request: NextRequest) {
  if (!(await withinEssentialLimit("preview", clientAddress(request), 30, 60))) return plain(429, "Too many at once. Try again in a minute.");
  const params = request.nextUrl.searchParams;
  const store = await storeForHandle(normaliseHandle(params.get("handle") ?? ""));
  if (!store) return plain(404, "There is no such store.");
  // One of the store's public requests for its window (lib/traffic.ts).
  if (!(await takePublicRequest(store))) return plain(429, "This store can't show previews right now. Try again later.");
  const product = await readListing(store, (params.get("product") ?? "").slice(0, 40));
  if (!product || product.hidden || product.preview < 1 || !product.file) return plain(404, "This product has no preview.");
  const copy = await previewCopy(product.file, product.preview, store);
  if (!copy) return plain(404, "This product has no preview right now.");
  return serveFile(copy, { paid: false });
}

/**
 * Sets how many first pages of a product's PDF anyone may read: `{ id, pages }`,
 * 0 to switch it off. The studio's side of the same thing.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products");
  if (!guarded.ok) return guarded.response;
  const id = text(guarded.body.id, 40);
  const pages = Number(guarded.body.pages);
  if (!id || !Number.isInteger(pages) || pages < 0 || pages > MAX_PREVIEW_PAGES) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  try {
    const result = await setProductPreview(guarded.ref, id, pages);
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "unknown" ? 404 : 400 });
    return Response.json({ ok: true, id: result.product.id, pages: result.product.preview });
  } catch (error) {
    console.error("changing a PDF preview failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
