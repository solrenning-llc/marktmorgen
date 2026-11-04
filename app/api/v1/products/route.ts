import { apiError, apiStore, takeMoreApi } from "@/lib/api-guard";
import { apiOkFields, badFields } from "@/lib/api-fields";
import { PRODUCT_FIELDS, products } from "@/lib/api-read";

/** GET /api/v1/products?cursor= — every product, in the creator's order; a page takes what reading its listings costs, first (lib/api-read-rules.ts). */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  // A ?fields= that cannot be answered is refused before any further request is taken or anything read.
  const bad = badFields(request, PRODUCT_FIELDS);
  if (bad) return bad;
  try {
    const found = await products(store, new URL(request.url).searchParams.get("cursor"), (more, taken) => takeMoreApi(store, more, taken));
    if (found instanceof Response) return found;
    return apiOkFields(request, found);
  } catch (error) {
    console.error("api: products failed", error);
    return apiError(502, "unavailable", "Products could not be read just now. Try again in a moment.");
  }
}
