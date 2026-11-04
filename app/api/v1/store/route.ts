import { apiStore } from "@/lib/api-guard";
import { apiOkFields } from "@/lib/api-fields";
import { storeInfo } from "@/lib/api-read";

/** GET /api/v1/store — which store this key reads. The first call to make, to check a key works. */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  return apiOkFields(request, { data: storeInfo(store) });
}
