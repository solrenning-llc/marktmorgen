import { apiError, apiStore } from "@/lib/api-guard";
import { apiOkFields } from "@/lib/api-fields";
import { affiliates } from "@/lib/api-read";

/** GET /api/v1/affiliates — every affiliate, with what they earned, were paid and are owed. */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  try {
    return apiOkFields(request, await affiliates(store));
  } catch (error) {
    console.error("api: affiliates failed", error);
    return apiError(502, "unavailable", "Affiliates could not be read just now. Try again in a moment.");
  }
}
