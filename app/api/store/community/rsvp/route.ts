import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { limited } from "@/lib/request-guard";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { within } from "@/lib/community";
import { communityViewer } from "@/lib/community-access";
import { ITEM_ID } from "@/lib/community-text";
import { cancelRsvp, mayAttend, readEvent, rsvp } from "@/lib/community-events";
import { restingAway, takeBuyerAction } from "@/lib/buyer-actions";

/** The most a form here may weigh: four short fields. */
const MAX_FORM_BYTES = 2_000;

/**
 * A member says they are coming to a live event, or that they are not any
 * more: a plain form that works without a script, answered with a move back
 * to the event's page and a word about what happened.
 *
 * Who is asking is worked out again here, whatever the page showed: let into
 * the community now (lib/community-access.ts) and, for an event kept for the
 * buyers of some products, holding one of them (lib/community-events.ts). A
 * muted member may still come to an event: muting stops writing, not
 * listening. The creator hosts, and takes no place. Each change counts
 * against the member's RSVP limit (lib/community-text.ts).
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_FORM_BYTES) {
    return new Response("Too large.", { status: 413 });
  }
  let form: FormData;
  try {
    form = await (await limited(request, MAX_FORM_BYTES)).formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const field = (name: string, max = 40) => String(form.get(name) ?? "").slice(0, max);
  const handle = normaliseHandle(field("handle"));
  const store = handle ? await storeForHandle(handle) : null;
  if (!store?.community) return new Response("Not found.", { status: 404 });
  const home = `/@${store.handle}/community`;
  const eventId = field("event", 12);
  const page = ITEM_ID.test(eventId) ? `${home}/events/${eventId}` : `${home}/events`;
  const back = (path: string, word: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}${path}?n=${word}`, "Cache-Control": "no-store" } });

  try {
    const viewer = await communityViewer(store, request.cookies);
    if (viewer.state !== "in") return back(home, viewer.state === "off" ? "off" : "out");
    if (viewer.owner) return back(page, "host");
    if (!viewer.member) return back(page, "full");
    // One of the store's buyer actions, before the event is read (lib/buyer-actions.ts).
    if (!(await takeBuyerAction(store))) return restingAway(origin, store);
    const id = store.community.id;
    const event = await readEvent(id, eventId);
    if (!event) return back(`${home}/events`, "gone");
    // Not known is said as not checked, never as an event that is not theirs (the pre-review of 9 November 2026, P4).
    const may = await mayAttend(store, viewer.config, event, { owner: false, email: viewer.email, holdings: viewer.holdings });
    if (may !== true) return back(page, may === "unknown" ? "eventunknown" : "eventlocked");
    if (!(await within(id, viewer.key, "rsvp"))) return back(page, "slow");

    if (field("action", 12) === "notgoing") {
      await cancelRsvp(id, event, viewer.key, store);
      return back(page, "notgoing");
    }
    const answer = await rsvp(id, event, viewer.key, store);
    if (answer === "full") return back(page, "eventfull");
    if (answer === "closed") return back(page, event.cancelled ? "eventcancelled" : "eventover");
    return back(page, viewer.member.mail ? "going" : "goingnomail");
  } catch (error) {
    // No room in the store's data room: the place was not taken (lib/store-data.ts).
    if (error instanceof DataRoomError) return back(page, "noroom");
    console.error("an RSVP failed", error);
    return back(page, "error");
  }
}
