import type { NextRequest } from "next/server";
import { StoreFullError, setProductPairs } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_PAIRS } from "@/lib/store-collections";
import { heldRefusal } from "@/lib/child-safety";

/**
 * Saves the products that go well with one product (lib/store-collections.ts):
 * `{ id, pairs: [productId, …] }`, up to MAX_PAIRS, in the order shown on its
 * page; an empty list for none. Needs the "products" permission, like the
 * rest of a product's settings.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 2_000);
  if (!guarded.ok) return guarded.response;
  const id = text(guarded.body.id, 64);
  if (!id) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  const onHold = await heldRefusal(guarded.store, id);
  if (onHold) return onHold;
  try {
    const result = await setProductPairs(guarded.ref, id, guarded.body.pairs);
    if (!result.ok) return Response.json({ ok: false, error: result.reason, max: MAX_PAIRS }, { status: result.reason === "none" || result.reason === "unknown" ? 404 : 400 });
    return Response.json({ ok: true, id: result.product.id, pairs: result.product.pairs ?? [] });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("saving a product's picks failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
