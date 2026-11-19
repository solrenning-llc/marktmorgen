"use client";

import { useEffect } from "react";
import { focusScrollBy } from "@/lib/studio-focus-clear";

/**
 * Keeps a focused control clear of the studio's sticky header and section bar where the browser does not
 * (WebKit ignores scroll-padding-top when it scrolls to focus; WCAG 2.4.11, 2.4.12; #3757). Rendered by StudioNav, so
 * only on pages that draw the bar. On focusin it reads the control's top and the sticky bars' bottoms once and, when
 * the control is under them, scrolls the page by the overlap, at once (no smooth motion, so prefers-reduced-motion
 * holds). It never moves focus, changes the tab order, or acts inside a dialog; where the browser already brought
 * the control clear (Chromium, Firefox) the rule answers 0 and nothing happens. Draws nothing.
 */
export function StudioFocusClear() {
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const control = event.target;
      if (!(control instanceof Element)) return;
      const bars = [document.querySelector("header"), document.querySelector("[data-studio-nav]")].filter(
        (bar): bar is Element => bar !== null && getComputedStyle(bar).position === "sticky",
      );
      const inBars = bars.some((bar) => bar.contains(control));
      const inDialog = control.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]') !== null;
      if (inBars || inDialog || bars.length === 0) return;
      const by = focusScrollBy({
        controlTop: control.getBoundingClientRect().top,
        barsBottom: Math.max(...bars.map((bar) => bar.getBoundingClientRect().bottom)),
        inDialog,
        inBars,
      });
      if (by !== 0) window.scrollBy({ top: by, behavior: "instant" });
    };
    document.addEventListener("focusin", onFocusIn, { passive: true });
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  return null;
}
