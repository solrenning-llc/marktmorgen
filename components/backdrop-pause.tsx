"use client";

import { useEffect, useState } from "react";

/** Where the choice is remembered in this browser, for every store: a convenience only, the page works without it. */
const KEPT = "mm-backdrop-still";

/**
 * The button that stops a store's Aurora backdrop drifting (WCAG 2.2.2 Pause, Stop, Hide), drawn by
 * app/[handle]/layout.tsx around every page of a store whose backdrop is the Aurora, in the store's words
 * (lib/buyer-words/backdrop-pause.ts). Pressed, it marks the document with data-backdrop-still, which pauses the
 * drift on every .st-page (app/globals.css); pressed again, the drift goes on from where it stopped. The choice is
 * remembered in this browser, if the browser lets it be, and applied as soon as a page opens. A device that asked
 * for less motion never sees the drift, so the stylesheet hides the button there.
 */
export function BackdropPause({ pause, play, lang }: { pause: string; play: string; lang?: string }) {
  const [still, setStill] = useState(false);

  useEffect(() => {
    let kept = false;
    try {
      kept = window.localStorage.getItem(KEPT) === "1";
    } catch {
      // Storage refused (a private window, blocked site data): the drift runs until the button is pressed.
    }
    if (kept) setStill(true);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (still) root.setAttribute("data-backdrop-still", "");
    else root.removeAttribute("data-backdrop-still");
    return () => root.removeAttribute("data-backdrop-still");
  }, [still]);

  const press = () => {
    const next = !still;
    setStill(next);
    try {
      if (next) window.localStorage.setItem(KEPT, "1");
      else window.localStorage.removeItem(KEPT);
    } catch {
      // Not remembered: this page still stops.
    }
  };

  return (
    <button type="button" lang={lang} data-backdrop-pause="" aria-pressed={still} onClick={press} className="btn st-btn-ghost text-sm">
      {still ? play : pause}
    </button>
  );
}
