/**
 * 602 [WP1], unit 1: the words and places of the buyer's mark on lesson
 * videos (lib/video-stamp.ts). The same day and order as the stamped PDF;
 * always in the top of the video; still for reduced motion; honest words.
 */
import { LOWEST_TOP, MOVE_SECONDS, STAMP_SPOTS, VIDEO_STAMP_NOTICE, VIDEO_STAMP_STUDIO_NOTE, stampSpot, videoStampText } from "@/lib/video-stamp";
import { stampLine } from "@/lib/pdf-stamp-line";
import { done, is, part } from "./check";

const at = new Date(Date.UTC(2026, 8, 26, 12));

part("The words");
const text = videoStampText("maya@example.com", "cs_live_a1B2c3D4e5F6", at);
is("email, day and the end of the order", text, "maya@example.com · Sep 26, 2026 · order …D4E5F6");
is("the same day and order as the stamped PDF", stampLine("maya@example.com", "cs_live_a1B2c3D4e5F6", at), "Sold to maya@example.com on Sep 26, 2026 · order …D4E5F6 · for personal use");

part("Places: always in the top, away from controls and captions");
is("six places", STAMP_SPOTS.length, 6);
is("every place is above the lowest line", STAMP_SPOTS.every((s) => s.top < LOWEST_TOP), true);
is("the lowest line leaves the bottom 40% free", LOWEST_TOP <= 60, true);

part("It moves, the same way for the same order");
const t0 = Date.UTC(2026, 10, 2, 15, 0, 0);
is("the same window, the same place", stampSpot("order1", t0, false), stampSpot("order1", t0 + 1000, false));
const seen = new Set<string>();
let repeats = 0;
for (let i = 0; i < 60; i += 1) {
  const a = stampSpot("order1", t0 + i * MOVE_SECONDS * 1000, false);
  const b = stampSpot("order1", t0 + (i + 1) * MOVE_SECONDS * 1000, false);
  seen.add(JSON.stringify(a));
  if (JSON.stringify(a) === JSON.stringify(b)) repeats += 1;
}
is("never the same place two windows in a row", repeats, 0);
is("it visits every place over time", seen.size, STAMP_SPOTS.length);

part("Reduced motion: it never moves");
is("the first place, whatever the time", [stampSpot("order1", t0, true), stampSpot("order1", t0 + 10 * MOVE_SECONDS * 1000, true)], [STAMP_SPOTS[0], STAMP_SPOTS[0]]);

part("Honest words: it discourages, never protects");
for (const [name, words] of [["notice", VIDEO_STAMP_NOTICE], ["studio note", VIDEO_STAMP_STUDIO_NOTE]] as const) {
  is(`${name} promises no protection`, /\b(protect|prevent|secure|stops? (?:piracy|copying)|can'?t be (?:copied|shared))/i.test(words.replace("cannot stop anyone", "")), false);
}
is("the studio says what it cannot do", VIDEO_STAMP_STUDIO_NOTE.includes("cannot stop anyone from recording"), true);
is("buyers are told before they pay", VIDEO_STAMP_NOTICE.includes("your email"), true);

done();
