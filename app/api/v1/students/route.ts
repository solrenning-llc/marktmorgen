import { apiError, apiStore, takeMoreApi } from "@/lib/api-guard";
import { apiOkFields } from "@/lib/api-fields";
import { students } from "@/lib/api-read";

/**
 * GET /api/v1/students?product=<id>&cursor= — everybody who has opened one course, with how far
 * they got, a page at a time; each page takes the further API requests reading its students'
 * progress costs, before it reads it (lib/api-read-rules.ts).
 */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  const params = new URL(request.url).searchParams;
  const product = (params.get("product") ?? "").slice(0, 60);
  if (!product) return apiError(400, "product_required", "Say which course: ?product=<the course product's id>, from /api/v1/products.");
  try {
    const found = await students(store, product, params.get("cursor"), (more) => takeMoreApi(store, more));
    if (found instanceof Response) return found;
    if (!found) return apiError(404, "not_a_course", "No course product with that id in this store.");
    return apiOkFields(request, found);
  } catch (error) {
    console.error("api: students failed", error);
    return apiError(502, "unavailable", "Students could not be read just now. Try again in a moment.");
  }
}
