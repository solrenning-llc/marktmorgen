import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { ITEM_ID_PATTERN, findLesson, isOpen, readCourse } from "@/lib/course";
import { courseAccess, emailKey, lessonVideo } from "@/lib/learn";
import { heldBack, passedForGate } from "@/lib/quiz";
import { clientAddress, essentialLimitState, limited } from "@/lib/request-guard";
import { readCourseListing } from "@/lib/catalog";
import { restingAway } from "@/lib/buyer-actions";
import { takePublicRequest } from "@/lib/traffic";
import { SESSION_COOKIE } from "@/lib/auth";
import { seesDrafts } from "@/lib/draft-view";
import { folderFromPathname } from "@/lib/delivery";
import { videoLimitFor } from "@/lib/plan-standing";
import { windowId } from "@/lib/allowance-window";
import { type LivePlayer, claimPlaying, dropPlayingClaim, keepPlayTicket, keepPlaying } from "@/lib/lesson-play";
import {
  PLAYS_PER_CONNECTION_WINDOW,
  PLAYS_PER_LEARNER_WINDOW,
  PLAY_REQUEST_UNITS,
  PLAY_WINDOW_SECONDS,
  PREVIEW_PLAYS_PER_STORE_WINDOW,
} from "@/lib/lesson-play-rules";

/**
 * A press of Play on a lesson video. The lesson page holds nothing when it is
 * drawn (lib/learn.ts, lessonPageVideo): a free preview is open to anyone, and
 * a draw that held playback let 26 anonymous page loads take a Studio plan's
 * 32 hours (pre-review of 9 November 2026). The press is a plain form, so it
 * works with no script; in this order it:
 *
 *   1. paces the connection (PLAYS_PER_CONNECTION_WINDOW), and refuses one
 *      past it before anything of the store is read for it;
 *   2. checks the lesson is open to the one pressing, as the page does: a
 *      draft only for its students and the store's people, a lesson that is
 *      not a preview only for a student whose module has opened and whom no
 *      quiz or assignment holds back;
 *   3. paces the signed-in person (PLAYS_PER_LEARNER_WINDOW) or, for anybody
 *      else, the store's anonymous previews (PREVIEW_PLAYS_PER_STORE_WINDOW);
 *   4. takes PLAY_REQUEST_UNITS of the store's public requests;
 *   5. one live hold a person a store (review of #3402, M1): gives a signed-in
 *      person's live token again for the same video, or for another lesson a
 *      token ending with it, holding nothing; or else, with their place claimed
 *      so that presses at once cannot each hold, holds the playback and signs a
 *      token (lib/learn.ts, lessonVideo: an anonymous press never takes the
 *      window below PREVIEW_KEEP_BPS, nor previews past their window's half);
 *   6. sends the browser back to the lesson with a ticket for the player, taken
 *      once, or with what kept it from playing, in words the page says.
 *
 * A count that cannot be read refuses, as an unknown always does (CX-123 rule
 * 24), and says the video could not be loaded rather than to slow down.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let handle = "";
  let productId = "";
  let lessonId = "";
  try {
    const form = await (await limited(request, 4_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    productId = String(form.get("product") ?? "").slice(0, 40);
    lessonId = String(form.get("lesson") ?? "").slice(0, 20);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!ITEM_ID_PATTERN.test(lessonId)) return new Response("Not found.", { status: 404 });

  const paced = await essentialLimitState("lesson-play-ip", clientAddress(request), PLAYS_PER_CONNECTION_WINDOW, PLAY_WINDOW_SECONDS);
  // Refused before the store is read (review of #3402, L3): back to the lesson asked for, its parts encoded.
  if (paced !== "within") {
    const asked = `${origin}/@${encodeURIComponent(handle)}/course/${encodeURIComponent(productId)}/${lessonId}`;
    return new Response(null, { status: 303, headers: { Location: `${asked}?play=${paced === "exceeded" ? "many" : "error"}#video`, "Cache-Control": "no-store" } });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("Not found.", { status: 404 });
  const product = await readCourseListing(store, productId);
  if (!product?.course) return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}`, "Cache-Control": "no-store" } });
  const base = `${origin}/@${store.handle}/course/${product.id}`;
  const lessonAt = `${base}/${lessonId}`;
  const back = (play: string) => new Response(null, { status: 303, headers: { Location: `${lessonAt}?play=${play}#video`, "Cache-Control": "no-store" } });

  const jar = await cookies();
  const access = await courseAccess(store, product, jar);
  // A draft is shown to its students and the store's owner and team only, a free preview included (MM-SA-30).
  if (product.hidden && access.state !== "open" && !(await seesDrafts(store, jar.get(SESSION_COOKIE)?.value))) {
    return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}`, "Cache-Control": "no-store" } });
  }
  const course = await readCourse(product.course.id);
  const found = course ? findLesson(course, lessonId) : null;
  const video = found?.lesson.video ?? null;
  if (!course || !found || !video) return new Response(null, { status: 303, headers: { Location: base, "Cache-Control": "no-store" } });
  const open = access.state === "open" && isOpen(course, found.unit, access.start);
  if (!open && !found.lesson.preview) return new Response(null, { status: 303, headers: { Location: base, "Cache-Control": "no-store" } });
  const student = access.state === "open" && !access.learner.owner ? access.learner : null;
  if (student && !found.lesson.preview) {
    // Held back by a quiz to pass or work to hand in: the page sends them there too.
    const blocker = heldBack(course, await passedForGate(course.id, emailKey(student.email))).get(found.lesson.id);
    if (blocker) return new Response(null, { status: 303, headers: { Location: `${base}/${blocker}?held=1#${findLesson(course, blocker)?.lesson.task ? "task" : "quiz"}`, "Cache-Control": "no-store" } });
  }

  const anonymous = access.state !== "open";
  const folder = folderFromPathname(video.pathname);
  const who = anonymous ? "" : `learner:${emailKey(access.learner.email)}`;
  const person = anonymous
    ? await essentialLimitState("lesson-play-preview", folder ?? store.handle, PREVIEW_PLAYS_PER_STORE_WINDOW, PLAY_WINDOW_SECONDS)
    : await essentialLimitState("lesson-play-learner", `${store.handle}:${who}`, PLAYS_PER_LEARNER_WINDOW, PLAY_WINDOW_SECONDS);
  if (person !== "within") return back(person === "exceeded" ? (anonymous ? "previews" : "many") : "error");
  // Public requests: on the buyers' side, or the public's for a preview pressed by somebody else (lib/buyer-actions.ts).
  if (!(await takePublicRequest(store, anonymous ? "public" : "buyer", Date.now(), PLAY_REQUEST_UNITS))) return restingAway(origin, store);

  // One live hold a person a store: their live token, or their place claimed for this press (lib/lesson-play.ts).
  let live: LivePlayer | null = null;
  let claim: string | null = null;
  if (who) {
    const place = folder ? await claimPlaying(who, folder) : null;
    if (!place) return back("error");
    if ("live" in place) live = place.live;
    else claim = place.claim;
  }
  const same = live !== null && live.pathname === video.pathname;
  const got = live && same
    ? { kind: "stream" as const, ...live.player }
    : live
      ? await lessonVideo(video, videoLimitFor(store), windowId(store), store, { until: live.expires })
      : await lessonVideo(video, videoLimitFor(store), windowId(store), store, { anonymous });
  if (claim && got?.kind !== "stream") await dropPlayingClaim(who, folder ?? "", claim);
  switch (got?.kind) {
    case "stream": {
      const player = { src: got.src, width: got.width, height: got.height };
      // Their live token is now this one (a moved token ends with the one before); a claim not replaced is let go.
      if (who && folder && !same && !(await keepPlaying(who, folder, video.pathname, player)) && claim) await dropPlayingClaim(who, folder, claim);
      const ticket = await keepPlayTicket(video.pathname, player);
      return back(ticket ?? "error");
    }
    case "busy":
      return back(`busy-${Math.min(24, Math.max(1, Math.ceil((got.until - Date.now()) / 3_600_000)))}`);
    case "kept":
    case "paused":
    case "preparing":
    case "failed":
      return back(got.kind);
    default:
      // A file of the private store is no press of Play's: the page links it as it always has.
      return back("error");
  }
}
