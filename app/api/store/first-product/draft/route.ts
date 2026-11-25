import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { addProduct } from "@/lib/store";
import { placeholderTitle } from "@/lib/first-product";
import { MAX_TITLE_LENGTH } from "@/lib/catalog-rules";

/**
 * The first product a creator wrote in the studio, made into a product draft (490 [PP1], unit 3): `{ title, price }`.
 * Always hidden (addProduct's draft, made in one write, so it is never briefly public), with no file yet: the
 * screen then sends the PDF it just made through the same upload the product editor uses (lib/sold-file-upload.ts)
 * and attaches it (app/api/store/file/attach). Nothing is published here: the creator reviews and publishes it in
 * the studio. Who may make it is who may change products; the price is the creator's, read as any product's.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 2_000);
  if (!guarded.ok) return guarded.response;
  const { body, ref } = guarded;
  const title = text(body.title, MAX_TITLE_LENGTH + 1).trim();
  if (!title || title === placeholderTitle("guide")) return Response.json({ ok: false, error: "title" }, { status: 400 });
  // A product's title is at most MAX_TITLE_LENGTH: a longer one is refused, never cut, so the product and the PDF agree.
  if (title.length > MAX_TITLE_LENGTH) return Response.json({ ok: false, error: "title_long" }, { status: 400 });
  const done = await addProduct(ref, title, "", text(body.price, 20), null, null, true);
  if (!done.ok) {
    const limit = "limit" in done ? done.limit : undefined;
    return Response.json({ ok: false, error: done.reason, ...(limit ? { limit } : {}) }, { status: 400 });
  }
  return Response.json({ ok: true, product: { id: done.product.id, title: done.product.title, hidden: done.product.hidden } });
}
