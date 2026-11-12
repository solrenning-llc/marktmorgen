/**
 * The buyer's mark on a course's lesson videos: 602 [WP1], unit 1 (owner's
 * Whop audit, 1 November 2026). The words and the places, pure and
 * browser-safe; the player shows them in a later unit, only when the creator
 * switches it on for the course, and never before the course page has told
 * the buyer.
 *
 * The same idea, and the same honesty, as the stamped PDF (lib/pdf-stamp.ts):
 * a quiet line with the signed-in student's own email, the day and the
 * order, drawn over the video by the page (nothing is re-encoded, so it costs
 * nothing per view). It makes a buyer think twice before sharing; it does
 * not stop anyone from recording a screen, and no sentence here says it does.
 *
 *   - It moves between places every MOVE_SECONDS, so it cannot be cropped
 *     out of one corner; for a student who asked their system for less
 *     motion (prefers-reduced-motion) it stays in one place, never moving.
 *   - Full screen: a video's own full-screen view shows the video alone,
 *     without anything the page draws over it. So a stamped player turns its
 *     own full screen and picture in picture off where the browser allows it
 *     (the service's frame is not given them; the file player is asked not
 *     to offer them) and offers a "Full screen" button that puts the video
 *     and the mark in full screen together (components/video-stamp.tsx).
 *     Some browsers and phones still offer their own full-screen view of a
 *     video (Firefox and Safari ignore that request on the file player; an
 *     iPhone has its own), and there the mark is not shown: the studio note
 *     says so, and nothing here claims otherwise.
 *   - The course page's notice to buyers (VIDEO_STAMP_NOTICE) is not shown
 *     yet. The unit that lets a creator switch the mark on must show it on
 *     the course page, with its test, in the same change.
 *   - Its places are all in the top 60% of the video, away from the
 *     controls and the captions at the bottom, so it never covers either.
 *   - It is not read by screen readers (it repeats the student's own email
 *     to them), cannot be clicked, and is drawn as incidental text over the
 *     picture, the kind WCAG 1.4.6 does not hold to a contrast ratio.
 */

/** How long the mark stays in one place, in seconds. */
export const MOVE_SECONDS = 45;

/** Where it may sit, as percentages of the video's box: always in the top 60%, away from controls and captions. */
export const STAMP_SPOTS: readonly { top: number; side: "left" | "right" }[] = [
  { top: 6, side: "left" },
  { top: 6, side: "right" },
  { top: 28, side: "right" },
  { top: 28, side: "left" },
  { top: 52, side: "left" },
  { top: 52, side: "right" },
];

/** The lowest the mark's top edge may be, in percent: below it are the controls and captions. */
export const LOWEST_TOP = 60;

/**
 * The mark's words: the student's email, the day they joined the course and,
 * when the page knows it, the end of the order number ("" leaves it out
 * rather than reading the order again on every lesson).
 */
export function videoStampText(email: string, reference: string, at: Date): string {
  const day = at.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const order = reference.replace(/^(cs|pi)_(test|live)?_?/, "").slice(-6).toUpperCase();
  return order ? `${email} · ${day} · order …${order}` : `${email} · ${day}`;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Which place the mark is in at `now` (ms). The same `seed` (the order) always
 * moves through the places in the same way; two moments in the same window
 * give the same place. With reduced motion, always the first place.
 */
export function stampSpot(seed: string, now: number, reducedMotion: boolean): (typeof STAMP_SPOTS)[number] {
  if (reducedMotion) return STAMP_SPOTS[0];
  const slot = Math.floor(now / (MOVE_SECONDS * 1000));
  const n = STAMP_SPOTS.length;
  // A start and a step of 1 or 5 places, both coprime with 6: it never stays put and visits every place.
  const start = hash(seed) % n;
  const step = hash(`${seed}:step`) % 2 === 0 ? 1 : 5;
  return STAMP_SPOTS[(((start + slot * step) % n) + n) % n];
}

/** What the course page tells a buyer before they pay, when the creator switched the mark on. */
export const VIDEO_STAMP_NOTICE =
  "This course's videos show your email and the date you joined while they play, to discourage sharing.";

/** What the studio tells the creator beside the switch. */
export const VIDEO_STAMP_STUDIO_NOTE =
  "Shows each student's email and the date they joined over the lesson videos, moving now and then. It discourages sharing; it cannot stop anyone from recording their screen. The Full screen button under the video keeps it showing, but it is not shown when a browser or phone plays the video full screen on its own. Buyers are told on the course page before they pay.";
