import { apiError, apiStore } from "@/lib/api-guard";
import { apiOkFields } from "@/lib/api-fields";
import { students } from "@/lib/api-read";

/** GET /api/v1/students?product=<id> — everybody who has opened one course, with how far they got. */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  const product = (new URL(request.url).searchParams.get("product") ?? "").slice(0, 60);
  if (!product) return apiError(400, "product_required", "Say which course: ?product=<the course product's id>, from /api/v1/products.");
  try {
    const found = await students(store, product);
    if (!found) return apiError(404, "not_a_course", "No course product with that id in this store.");
    return apiOkFields(request, found);
  } catch (error) {
    console.error("api: students failed", error);
    return apiError(502, "unavailable", "Students could not be read just now. Try again in a moment.");
  }
}
