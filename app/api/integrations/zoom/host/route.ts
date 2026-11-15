import { serviceRefusalCode, withinServiceWhy } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { hostLink } from "@/lib/meet-links";
import { isScope } from "@/lib/meet-records";
import { isConfigured } from "@/lib/meet-providers";
import { isEventScopeOf } from "@/lib/event-meetings";
import { originFrom } from "@/lib/request-origin";
import { away, studioAccess, studioPath } from "@/lib/studio-route";
import { lockUnreadPage } from "@/lib/two-step-unknown";

/** Host links one store may ask for in ten minutes. */
const PER_TEN_MINUTES = 30;

/**
 * "Start in Zoom" next to a booked call in the studio, or a community live
 * event (lib/event-meetings.ts): asks Zoom for the meeting's host link at
 * this moment and sends the creator there. The host
 * link starts the meeting as its host, so it is never stored, never emailed
 * and never shown to a buyer; only the owner and Admins of the store whose
 * meeting it is ("settings") are sent to it.
 */
export async function GET(request: NextRequest) {
  if (!isConfigured("zoom")) return new Response("Not found.", { status: 404 });
  const origin = originFrom(request);
  const result = await studioAccess(request, "settings");
  if (!result.ok) {
    // The same answers as every studio route (lib/studio-route.ts, creatorFrom).
    if (result.reason === "signed_out") return away(origin, "/signin?status=expired");
    if (result.reason === "no_store") return away(origin, "/studio?stripe=nostore");
    if (result.reason === "gone") return away(origin, "/studio?team=gone");
    // The lock could not be read: nothing is opened, and it is said (rule 24, lib/two-step-unknown.ts).
    if (result.reason === "unread") return lockUnreadPage(`${origin}/studio`, "your studio");
    return away(origin, studioPath(result.store ?? { sid: "" }, "team=forbidden"));
  }
  const { store } = result.access;
  const scope = request.nextUrl.searchParams.get("scope") ?? "";
  const back = away(origin, studioPath(store, "meet=host&p=zoom", "meetings"));
  // Only a scope of this store's own: one of its calls, or one of its community's events.
  const ours = (store.callsId && scope.startsWith(`c:${store.callsId}:`)) || isEventScopeOf(scope, store.community?.id);
  if (!isScope(scope) || !store.statsId || !ours) return back;
  // Refused before Zoom is asked: said as such, never as Zoom not giving the link.
  const refused = await withinServiceWhy("meet-host", store.statsId, PER_TEN_MINUTES, 600, store);
  if (refused) return away(origin, studioPath(store, `meet=${serviceRefusalCode(refused, "limited")}&p=zoom`, "meetings"));
  try {
    const url = await hostLink(store, scope);
    if (!url) return back;
    return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("asking Zoom for a host link failed", error);
    return back;
  }
}
