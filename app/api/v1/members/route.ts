import { apiError, apiStore } from "@/lib/api-guard";
import { apiOkFields } from "@/lib/api-fields";
import { members } from "@/lib/api-read";

/** GET /api/v1/members?cursor= — the community's members, as the creator's member list shows them. */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  if (!store.community) return apiError(404, "no_community", "This store has no community.");
  try {
    return apiOkFields(request, await members(store, new URL(request.url).searchParams.get("cursor")));
  } catch (error) {
    console.error("api: members failed", error);
    return apiError(502, "unavailable", "Members could not be read just now. Try again in a moment.");
  }
}
