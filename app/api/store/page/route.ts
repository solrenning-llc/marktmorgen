import { fastMoneyOnPage } from "@/lib/terms-check-rules";
import { pageWords } from "@/lib/page-translate";
import type { NextRequest } from "next/server";
import { StoreFullError, imageFolder, isFree, setProductPage } from "@/lib/store";
import { productIdFor, readListing } from "@/lib/catalog";
import { guardStoreWrite, text } from "@/lib/store-request";
import { EMPTY_PAGE, MAX_BLOCKS, copyOfPage, declareMeasure, oversized, pageProblem, parsePage, picturePaths } from "@/lib/sales-page";
import { jsonAccess } from "@/lib/studio-route";
import { claimPictures, readPage, releasePictures, writePage } from "@/lib/sales-page-store";
import { del } from "@/lib/blob";
import { imagePaths, ownsImagePath } from "@/lib/product-image";
import { isStoredPicture } from "@/lib/picture-check";

/**
 * Thirty full blocks as JSON, twice — a page and a second version tested
 * against it — with room to spare; each is held to MAX_PAGE_BYTES.
 */
const MAX_BODY_BYTES = 420_000;

/**
 * Saves a product's page of blocks (lib/sales-page.ts), or clears it.
 *
 * `{ id, page: { blocks, seoTitle, seoDescription, next, test, variant } }`, or
 * `{ id, page: null }` for the plain page again. Every rule the product's
 * page applies is applied here first, and a page that would be saved
 * differently from how it was sent is refused with the reason, so the
 * studio never says "saved" about something it did not save.
 */
export async function POST(request: NextRequest) {
  // A product's page is part of the product (lib/team-roles.ts): owner, Admin, Editor.
  const guarded = await guardStoreWrite(request, "products", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const body = guarded.body;
  const id = text(body.id, 40);
  if (!id || !("page" in body)) return Response.json({ ok: false, error: "unknown" }, { status: 400 });

  const store = guarded.store;
  const product = await readListing(store, id);
  if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 400 });

  const raw = body.page && typeof body.page === "object" ? (body.page as Record<string, unknown>) : null;
  const page = raw ? parsePage(raw) : { ...EMPTY_PAGE, blocks: [] };
  if (raw) {
    if (Array.isArray(raw.blocks) && raw.blocks.length > MAX_BLOCKS) return Response.json({ ok: false, error: "too_many" }, { status: 400 });
    const problem = pageProblem(raw, page);
    if (problem) return Response.json({ ok: false, error: problem }, { status: 400 });
    // A form is asked on the store's own pages, where it can lead a funnel on; a product's page has its own checkout.
    if (page.blocks.some((block) => block.kind === "form")) return Response.json({ ok: false, error: "kind" }, { status: 400 });
    if (oversized(page)) return Response.json({ ok: false, error: "too_big" }, { status: 400 });
    // What is shown after a free sign-up is another product of this store,
    // one that costs money; a paid product's page shows nothing after.
    const sentNext = typeof raw.next === "string" && raw.next ? raw.next : null;
    if (sentNext) {
      const next = await readListing(store, sentNext);
      if (!isFree(product) || !next || next.id === product.id || isFree(next)) {
        return Response.json({ ok: false, error: "next" }, { status: 400 });
      }
    }
  }

  // A page is on the store with its product: what the Terms forbid is refused while the product is published
  // (567 [GD1] (d), unit 2), with the passage, why and the fix; a draft's page may be saved, and is checked when
  // the product is published. A product that cannot be read was refused above.
  if (product.hidden !== true) {
    const refused = fastMoneyOnPage(pageWords(page));
    if (refused) return Response.json({ ok: false, error: "fast_money", passage: refused }, { status: 409 });
  }

  const has = page.blocks.length > 0 || page.seoTitle !== "" || page.seoDescription !== "" || page.next !== null;
  try {
    // The pictures on the page (lib/sales-page.ts, PicturesBlock). What the
    // browser says it uploaded is never taken at face value: each new one
    // has to be a file in this store's own picture folder that really is a
    // picture, not the product's own picture under another name, and not
    // one another product's page is already showing.
    const stored = store.statsId && product.page ? await readPage(store.statsId, id) : null;
    const before = stored ? picturePaths(stored) : [];
    const shown = picturePaths(page);
    const fresh = shown.filter((path) => !before.includes(path));
    if (fresh.length > 0) {
      if (!store.statsId) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
      const folder = await imageFolder(guarded.ref);
      const own = new Set(imagePaths(product.image));
      for (const path of fresh) {
        if (!ownsImagePath(path, folder) || own.has(path) || !(await isStoredPicture(path))) {
          return Response.json({ ok: false, error: "pictures" }, { status: 400 });
        }
      }
      const taken = await claimPictures(store.statsId, id, fresh);
      if (taken.length > 0) {
        await releasePictures(store.statsId, id, fresh);
        return Response.json({ ok: false, error: "pictures" }, { status: 400 });
      }
    }

    const marked = await setProductPage(guarded.ref, id, has);
    if (!marked.ok) return Response.json({ ok: false, error: marked.reason }, { status: 400 });
    if (!marked.store.statsId) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
    // A running test declares, once, the measure it is decided by (lib/headline-test-rules.ts, rule 2).
    const saved = declareMeasure(page, stored, isFree(product) ? "checkouts" : "money");
    await writePage(marked.store.statsId, id, saved, marked.store);
    // A picture taken off the page is deleted, best effort and only after the
    // page that no longer shows it is written.
    const gone = await releasePictures(marked.store.statsId, id, before.filter((path) => !shown.includes(path))).catch(() => [] as string[]);
    if (gone.length > 0) {
      await del(gone).catch((error: unknown) => console.error("could not delete pictures taken off a page", error));
    }
    // The page as it was kept, so the editor shows exactly that without starting over.
    return Response.json({ ok: true, blocks: saved.blocks.length, page: saved });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("saving a product page failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

/**
 * Another product's page of this store, to start a page from: `?id=<product>`.
 * Its blocks with fresh ids and without its pictures (lib/sales-page.ts,
 * copyOfPage); nothing is saved here.
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "products");
  if (access instanceof Response) return access;
  const id = (request.nextUrl.searchParams.get("id") ?? "").slice(0, 40);
  const store = access.store;
  if (!store || !id || productIdFor(store, id) !== id) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  try {
    const copy = copyOfPage(await readPage(store.statsId, id));
    return Response.json({ ok: true, ...copy }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("reading a page to copy failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
