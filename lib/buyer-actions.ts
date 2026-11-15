/**
 * What buyers do inside what they bought, counted in the store's month
 * (added 18 October 2026, when tests/plan-cost-registry.ts still listed
 * them as OPEN: bounded per person, never per store).
 *
 * Two kinds of request, each taken before anything else is read or written:
 *
 *   an action      a community post, comment, edit, like, vote, report,
 *                  RSVP, message, live-room message, picture door or phone
 *                  sign-up; a lesson comment, a hand-in and its upload door,
 *                  a lesson marked done, a certificate made. One of the
 *                  store's "buyer" figure (lib/store-allowance-rules.ts). The
 *                  creator acting in their own community or lessons takes
 *                  one of their studio requests instead.
 *   a read         a community picture, an event's calendar file, a
 *                  lesson's download, a sign-in link asked for or opened, a
 *                  podcast episode: one of the store's public requests on the
 *                  buyers' side (lib/traffic.ts, takePublicRequest), several
 *                  for a picture, whose bytes pass through us.
 *
 * Deleting what one wrote is never counted: it can only follow an action
 * that was, and the action's unit is priced to cover both.
 *
 * Past the figure, a buyer is sent to the page that says the store is
 * resting for now (app/[handle]/resting), or told so in the answer; what
 * they already have is kept, and nobody is ever stopped while paying.
 */
import type { Store } from "@/lib/store";
import { takeAllowance } from "@/lib/store-allowance";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { takePublicRequest } from "@/lib/traffic";

/** Public requests a community picture counts as: its bytes pass through us (tests/plan-cost-registry.ts holds the price). */
export const PICTURE_REQUEST_UNITS = 4;

/**
 * Public requests each step of opening an emailed community or course link
 * counts as (MM-SA-41): the link's GET (it reads the link and the store), the
 * page that asks for the press (it reads the store and draws the form) and the
 * press itself (it spends the open and writes the pass). Each takes its own
 * before what it serves, so a mail filter or a script that fetches the link or
 * its page again and again, and never presses, is counted every time
 * (tests/open-link-get-counted.test.ts). The whole open is the three together
 * (tests/open-link-post.test.ts holds its commands under it).
 */
export const OPEN_LINK_GET_UNITS = 1;
export const OPEN_LINK_PAGE_UNITS = 1;
export const OPEN_LINK_TAP_UNITS = 1;
export const OPEN_LINK_REQUEST_UNITS = OPEN_LINK_GET_UNITS + OPEN_LINK_PAGE_UNITS + OPEN_LINK_TAP_UNITS;

/** One action, taken from the store's month: the buyer's figure, or the creator's studio requests. */
export async function takeBuyerAction(store: Store, by: "buyer" | "owner" = "buyer"): Promise<boolean> {
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return false;
  const taken = by === "owner" ? await takeAllowance(store, "studio") : await takeAllowance(store, "buyer");
  return taken.ok;
}

/** One read on the buyers' side, `units` of the store's public requests. */
export async function takeBuyerRead(store: Store, units = 1): Promise<boolean> {
  return takePublicRequest(store, "buyer", Date.now(), units);
}

/** Where a form goes when the store cannot take it this month. */
export function restingAway(origin: string, store: Pick<Store, "handle">): Response {
  return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/resting`, "Cache-Control": "no-store" } });
}

/** The answer a script is given when the store cannot take it this month. */
export function restingJson(): Response {
  return Response.json({ ok: false, error: "resting" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
