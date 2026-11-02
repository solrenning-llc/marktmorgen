"use client";

import { useSyncExternalStore } from "react";
import { MOVE_SECONDS, stampSpot } from "@/lib/video-stamp";

/**
 * The buyer's mark over a lesson video (602 [WP1], lib/video-stamp.ts): one
 * quiet line with the student's own email and day, moving between places in
 * the top of the video every MOVE_SECONDS, and never moving for a student who
 * asked for less motion. Not read by screen readers (it repeats their own
 * email), not focusable, and never in the way of a click.
 */
const REDUCE = "(prefers-reduced-motion: reduce)";
const onMotionSetting = (changed: () => void) => {
  const query = window.matchMedia(REDUCE);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
};
const onClock = (changed: () => void) => {
  const timer = window.setInterval(changed, 5_000);
  return () => window.clearInterval(timer);
};

export function VideoStamp({ text, seed }: { text: string; seed: string }) {
  // Still on the server and until the browser says otherwise.
  const still = useSyncExternalStore(onMotionSetting, () => window.matchMedia(REDUCE).matches, () => true);
  const slot = useSyncExternalStore(onClock, () => Math.floor(Date.now() / (MOVE_SECONDS * 1000)), () => -1);
  const spot = stampSpot(seed, Math.max(slot, 0) * MOVE_SECONDS * 1000, still || slot < 0);
  return (
    <span
      aria-hidden="true"
      data-video-stamp=""
      data-move-seconds={MOVE_SECONDS}
      className="pointer-events-none absolute z-10 select-none whitespace-nowrap rounded px-1.5 py-0.5 text-[0.75rem] font-medium"
      style={{
        top: `${spot.top}%`,
        [spot.side]: "3%",
        color: "rgba(255,255,255,0.72)",
        background: "rgba(0,0,0,0.28)",
        textShadow: "0 0 2px rgba(0,0,0,0.9)",
        maxWidth: "70%",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {text}
    </span>
  );
}
