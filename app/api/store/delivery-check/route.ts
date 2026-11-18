import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { hasProduct, readListingExactly } from "@/lib/catalog";
import { countStudio } from "@/lib/studio-route";
import { checkDelivery } from "@/lib/delivery-check";
import { DELIVERY_CHECK_UNITS, leftWords } from "@/lib/delivery-check-rules";

/**
 * Checks now that what one product delivers still works (479 [SB2], unit 2): `{ id }`. Who may change products may
 * check them. A product the store does not have is refused before anything is taken; then DELIVERY_CHECK_UNITS studio
 * requests are taken, before the product is read and before anything it hands over is asked for. A product whose
 * record answers in an unknown shape is said as such and nothing is checked. Nothing is written.
 */
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 1_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const id = text(body.id, 40);
  if (!id || !hasProduct(store, id)) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  const paid = await countStudio(store, null, DELIVERY_CHECK_UNITS);
  if (!paid.ok) {
    return Response.json({ ok: false, error: "studio_used", message: paid.message ? `${paid.message} Nothing was checked.` : "Nothing was checked." }, { status: 429 });
  }
  const listing = await readListingExactly(store, id).catch(() => "unknown" as const);
  if (listing === "unknown") {
    return Response.json({ ok: false, error: "unavailable", message: "We could not read this product just now, so nothing was checked. Try again in a minute." }, { status: 503 });
  }
  if (!listing) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  const result = await checkDelivery(listing);
  return Response.json({ ok: true, items: result.items, left: result.left, leftNote: leftWords(result.left) });
}
