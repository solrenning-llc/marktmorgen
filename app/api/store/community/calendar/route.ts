import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { fileHeaders, limitUnknownResponse, unknownLimit } from "@/lib/request-guard";
import { communityViewer } from "@/lib/community-access";
import { eventIcs, mayAttend, readEvent } from "@/lib/community-events";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { speech } from "@/lib/buyer-words";

/**
 * The calendar file for a community live event, for its "Add to calendar"
 * button. Only for somebody the community lets in, and the event too
 * (lib/community-events.ts), asked again now. The file names the event's
 * page as where it happens, never the room: whoever opens the calendar entry
 * later is asked again by the page.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const handle = normaliseHandle(url.searchParams.get("h") ?? "");
  const eventId = url.searchParams.get("e") ?? "";
  const store = handle ? await storeForHandle(handle) : null;
  const refuse = () => new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!store?.community) return refuse();
  const viewer = await communityViewer(store, request.cookies).catch(() => null);
  if (!viewer || viewer.state !== "in") return refuse();
  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts).
  const taken = await takeBuyerRead(store).catch(unknownLimit);
  // A count that could not be read is never "resting" or "too many" (rule 24): it could not be checked just now.
  if (taken === "unknown") return limitUnknownResponse();
  if (!taken) return new Response(speech(store).w.restingTitle, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  const event = await readEvent(store.community.id, eventId);
  if (!event || !(await mayAttend(store, viewer.config, event, { owner: viewer.owner, email: viewer.email }))) return refuse();
  return new Response(eventIcs(store, event, viewer.config.name), {
    headers: fileHeaders("text/calendar; charset=utf-8", "event.ics"),
  });
}
