import { apiError, apiStore, holdMoreApi } from "@/lib/api-guard";
import { apiOkFields, badFields } from "@/lib/api-fields";
import { MEMBER_FIELDS, members, sentCursor } from "@/lib/api-read";

/** GET /api/v1/members?cursor= — the community's members, as the creator's member list shows them. */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  if (!store.community) return apiError(404, "no_community", "This store has no community.");
  // A ?fields= that cannot be answered is refused before any further request is taken or anything read.
  const bad = badFields(request, MEMBER_FIELDS);
  if (bad) return bad;
  // A cursor sent twice is refused before anything is read or taken (#4363).
  const cursor = sentCursor(new URL(request.url).searchParams);
  if (!cursor.ok) return cursor.refused;
  try {
    // A page at its most is set aside before the scan, and settled at what it read and sends before it is sent (lib/api-read-rules.ts, listPageMost, scannedPageWork).
    const found = await members(store, cursor.cursor, (most) => holdMoreApi(store, most));
    if (found instanceof Response) return found;
    return apiOkFields(request, found);
  } catch (error) {
    console.error("api: members failed", error);
    return apiError(502, "unavailable", "Members could not be read just now. Try again in a moment.");
  }
}
