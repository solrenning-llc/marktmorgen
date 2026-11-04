import { apiError, apiStore, takeMoreApi } from "@/lib/api-guard";
import { apiOkFields, badFields } from "@/lib/api-fields";
import { AFFILIATE_FIELDS, affiliates } from "@/lib/api-read";

/**
 * GET /api/v1/affiliates — every affiliate, with what they earned, were paid and are owed. It takes
 * the further API requests the program's size costs to read, before reading it (lib/api-read-rules.ts).
 */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  // A `?fields=` that cannot be answered is refused before any further request is taken or anything read.
  const bad = badFields(request, AFFILIATE_FIELDS);
  if (bad) return bad;
  try {
    const found = await affiliates(store, (more) => takeMoreApi(store, more));
    if (found instanceof Response) return found;
    return apiOkFields(request, found);
  } catch (error) {
    console.error("api: affiliates failed", error);
    return apiError(502, "unavailable", "Affiliates could not be read just now. Try again in a moment.");
  }
}
