import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { UNSUB_TOKEN, unsubscribe } from "@/lib/contacts";
import { STOP_TOKEN, stopReminders } from "@/lib/checkout-recovery";
import { COMMUNITY_UNSUB, stopAnnouncements } from "@/lib/community-mail";
import { limited } from "@/lib/request-guard";
import { REVIEW_STOP, stopReviewRequests } from "@/lib/review-requests";
import { UPDATE_STOP, stopUpdates } from "@/lib/product-updates";
import { stopCounting } from "@/lib/mail-clicks";

/**
 * Leaving a creator's list. A mail app's own unsubscribe button posts here
 * with no page at all (RFC 8058); the link in the email reaches the same
 * thing through a page with one button. Either way it takes one press, it is
 * kept for good, and nobody is asked why.
 *
 * The same door stops a store's abandoned-checkout reminders (an `r` link
 * rather than a `t` one, lib/checkout-recovery.ts), which are sent to people
 * who may never have joined the list, and a community member's announcement
 * emails (a `c` link, lib/community-mail.ts), which leaves them in the
 * community and on or off the list exactly as they were, and a store's
 * emails asking for a review (a `v` link, lib/review-requests.ts), and a
 * store's emails telling its buyers of an update (a `u` link,
 * lib/product-updates.ts). And an `l` link stops the counting of which
 * links somebody uses, which they allowed apart (lib/mail-clicks.ts),
 * leaving them on the list.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  const links = (request.nextUrl.searchParams.get("l") ?? "").slice(0, 60);
  if (UNSUB_TOKEN.test(links)) {
    const found = await stopCounting(links);
    return new Response(null, {
      status: 303,
      headers: { Location: `${origin}/unsubscribe?l=${links}&done=${found ? "1" : "0"}`, "Cache-Control": "no-store" },
    });
  }
  const token = (request.nextUrl.searchParams.get("t") ?? "").slice(0, 60);
  const reminder = (request.nextUrl.searchParams.get("r") ?? "").slice(0, 60);
  const community = (request.nextUrl.searchParams.get("c") ?? "").slice(0, 60);
  const review = (request.nextUrl.searchParams.get("v") ?? "").slice(0, 60);
  const update = (request.nextUrl.searchParams.get("u") ?? "").slice(0, 60);
  let fromPage = false;
  if (!UNSUB_TOKEN.test(token) && !STOP_TOKEN.test(reminder) && !COMMUNITY_UNSUB.test(community) && !REVIEW_STOP.test(review) && !UPDATE_STOP.test(update)) {
    return new Response("Not found.", { status: 404 });
  }
  try {
    const form = await (await limited(request, 8_000)).formData();
    fromPage = form.get("from") === "page";
  } catch {
    fromPage = false;
  }
  const done = UPDATE_STOP.test(update)
    ? await stopUpdates(update)
    : REVIEW_STOP.test(review)
    // A stop whose write cannot be confirmed is not done (CX-123 rule 24): null, answered below.
    ? await stopReviewRequests(review).catch(() => null)
    : COMMUNITY_UNSUB.test(community)
    // A stop whose read or write cannot be confirmed is not done (CX-123 rule 24): null, answered below.
    ? await stopAnnouncements(community).catch(() => null)
    : STOP_TOKEN.test(reminder)
      // A stop whose write cannot be confirmed is not done (CX-123 rule 24): null, answered below.
      ? await stopReminders(reminder).catch(() => null)
      // A list link: true left, false no such link (an exact nil), null a read or write not confirmed (CX-123 rule 24).
      : await unsubscribe(token).then((left) => left !== null, () => null);
  const which = UPDATE_STOP.test(update) ? `u=${update}` : REVIEW_STOP.test(review) ? `v=${review}` : COMMUNITY_UNSUB.test(community) ? `c=${community}` : STOP_TOKEN.test(reminder) ? `r=${reminder}` : `t=${token}`;
  if (fromPage) {
    return new Response(null, {
      status: 303,
      headers: { Location: `${origin}/unsubscribe?${which}&done=${done ? "1" : "0"}`, "Cache-Control": "no-store" },
    });
  }
  if (done === null) {
    // Never "Unsubscribed." for a stop not saved, nor "Not found." for a link that exists.
    return new Response("We could not save that just now. Please try again in a minute.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "60" },
    });
  }
  return new Response(done ? "Unsubscribed." : "Not found.", {
    status: done ? 200 : 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** A link opened by hand goes to the page with the button, never straight through. */
export async function GET(request: NextRequest) {
  const origin = originFrom(request);
  const token = (request.nextUrl.searchParams.get("t") ?? "").slice(0, 60);
  const reminder = (request.nextUrl.searchParams.get("r") ?? "").slice(0, 60);
  const community = (request.nextUrl.searchParams.get("c") ?? "").slice(0, 60);
  const review = (request.nextUrl.searchParams.get("v") ?? "").slice(0, 60);
  const update = (request.nextUrl.searchParams.get("u") ?? "").slice(0, 60);
  const which = update
    ? `u=${encodeURIComponent(update)}`
    : review
    ? `v=${encodeURIComponent(review)}`
    : community
    ? `c=${encodeURIComponent(community)}`
    : reminder
      ? `r=${encodeURIComponent(reminder)}`
      : `t=${encodeURIComponent(token)}`;
  return new Response(null, { status: 303, headers: { Location: `${origin}/unsubscribe?${which}` } });
}
