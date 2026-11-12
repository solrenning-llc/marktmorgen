"use client";

import { useEffect, useSyncExternalStore } from "react";

/** Where the choice is remembered in this browser, for every store: a convenience only, the page works without it. */
const KEPT = "mm-backdrop-still";

/** The choice for this page when the browser refuses storage (a private window, blocked site data). */
let held = false;
const listeners = new Set<() => void>();

function readStill(): boolean {
  try {
    return window.localStorage.getItem(KEPT) === "1";
  } catch {
    return held;
  }
}

function subscribe(changed: () => void): () => void {
  listeners.add(changed);
  // Pressed in another tab of the same browser: this page follows.
  window.addEventListener("storage", changed);
  return () => {
    listeners.delete(changed);
    window.removeEventListener("storage", changed);
  };
}

function keepStill(still: boolean): void {
  held = still;
  try {
    if (still) window.localStorage.setItem(KEPT, "1");
    else window.localStorage.removeItem(KEPT);
  } catch {
    // Not remembered: this page still stops, from `held`.
  }
  for (const changed of listeners) changed();
}

/**
 * The button that stops a store's Aurora backdrop drifting (WCAG 2.2.2 Pause, Stop, Hide), drawn by
 * app/[handle]/layout.tsx around every page of a store whose backdrop is the Aurora, in the store's words
 * (lib/buyer-words/backdrop-pause.ts). Pressed, it marks the document with data-backdrop-still, which pauses the
 * drift on every .st-page (app/globals.css); pressed again, the drift goes on from where it stopped. The choice is
 * remembered in this browser, if the browser lets it be, and applied as soon as a page opens. The server draws it
 * unpressed. A device that asked for less motion never sees the drift, so the stylesheet hides the button there.
 */
export function BackdropPause({ pause, play, lang }: { pause: string; play: string; lang?: string }) {
  const still = useSyncExternalStore(subscribe, readStill, () => false);

  useEffect(() => {
    const root = document.documentElement;
    if (still) root.setAttribute("data-backdrop-still", "");
    else root.removeAttribute("data-backdrop-still");
    return () => root.removeAttribute("data-backdrop-still");
  }, [still]);

  return (
    <button type="button" lang={lang} data-backdrop-pause="" aria-pressed={still} onClick={() => keepStill(!still)} className="btn st-btn-ghost text-sm">
      {still ? play : pause}
    </button>
  );
}
