"use client";

import { type ReactNode, useRef, useSyncExternalStore } from "react";
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

const onFullscreen = (changed: () => void) => {
  document.addEventListener("fullscreenchange", changed);
  return () => document.removeEventListener("fullscreenchange", changed);
};
const never = () => () => {};

/**
 * A stamped lesson player. A video's own full-screen view shows the video
 * alone, so the mark over it would be left behind: the page turns the
 * player's own full screen off (the lesson page does it, only when stamped)
 * and offers this "Full screen" button instead, which puts the video and the
 * mark in full screen together. Where the browser has no full-screen support
 * (an iPhone, say), the button stays hidden, rather than doing nothing.
 */
export function StampedPlayer({ text, seed, enter, exit, children }: { text: string; seed: string; enter: string; exit: string; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // Hidden on the server and until the browser says it can.
  const can = useSyncExternalStore(never, () => document.fullscreenEnabled === true && typeof HTMLElement.prototype.requestFullscreen === "function", () => false);
  const full = useSyncExternalStore(onFullscreen, () => document.fullscreenElement !== null && document.fullscreenElement === box.current, () => false);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void box.current?.requestFullscreen().catch(() => {});
  };
  return (
    <div
      ref={box}
      data-stamped-player=""
      className="mt-6 [&:fullscreen]:flex [&:fullscreen]:flex-col [&:fullscreen]:justify-center [&:fullscreen]:bg-[var(--st-bg)] [&:fullscreen]:p-4 [&:fullscreen]:[--player-tall:calc(100vh-6.5rem)]"
    >
      <div className="relative overflow-hidden rounded-2xl bg-black">
        <VideoStamp text={text} seed={seed} />
        {children}
      </div>
      {/* Drawn hidden, and shown only once the browser says it can go full
          screen: before that it could not do anything. */}
      <div data-full-screen-row="" className={can ? "mt-2 flex justify-end" : "hidden"}>
        <button type="button" className="btn st-btn" onClick={toggle}>
          {full ? exit : enter}
        </button>
      </div>
    </div>
  );
}
