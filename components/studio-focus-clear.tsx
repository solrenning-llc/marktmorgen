"use client";

import { useEffect } from "react";
import { focusScrollBy, stuckBarsBottom, visibleTop } from "@/lib/studio-focus-clear";

/**
 * Keeps a focused control clear of the studio's sticky header and section bar where the browser does not
 * (WebKit ignores scroll-padding-top when it scrolls to focus; WCAG 2.4.11, 2.4.12; #3757). Rendered by StudioNav, so
 * only on pages that draw the bar. On focusin it reads the control's top and the bottoms of the sticky bars stuck at the top once and, when
 * the control is under them, scrolls the page by the overlap, at once (no smooth motion, so prefers-reduced-motion
 * holds). It never moves focus, changes the tab order, or acts inside a dialog; where the browser already brought
 * the control clear (Chromium, Firefox) the rule answers 0 and nothing happens. A focus that comes with a mouse or
 * touch press is left alone until that press ends: moving the page under the pointer would carry the click away.
 * Draws nothing.
 */
/** The control's own label: the first one the browser links to it, or the label it sits in. */
function labelOf(control: Element): Element | null {
  const linked = "labels" in control ? (control as HTMLInputElement).labels : null;
  return linked?.[0] ?? control.closest("label");
}

export function StudioFocusClear() {
  useEffect(() => {
    // True from a press's pointerdown until just after its click: the focus it gives is the click's own.
    let pressing = false;
    let release: ReturnType<typeof setTimeout> | undefined;
    const onPointerDown = () => {
      clearTimeout(release);
      pressing = true;
    };
    const onPointerEnd = () => {
      clearTimeout(release);
      // After the click this pointerup leads to (and the focus a label's click gives its input), never before it.
      release = setTimeout(() => {
        pressing = false;
      }, 0);
    };
    const onFocusIn = (event: FocusEvent) => {
      const control = event.target;
      if (!(control instanceof Element)) return;
      // Every sticky <header> and section bar, never only the first <header> in the document (Claude 5 on #3757).
      const bars = Array.from(document.querySelectorAll("header, [data-studio-nav]")).filter((bar) => getComputedStyle(bar).position === "sticky");
      const inBars = bars.some((bar) => bar.contains(control));
      const inDialog = control.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]') !== null;
      if (pressing || inBars || inDialog || bars.length === 0) return;
      const by = focusScrollBy({
        // A visually hidden control (an sr-only radio inside its label) is measured by the label a person sees.
        controlTop: visibleTop(control.getBoundingClientRect(), labelOf(control)?.getBoundingClientRect() ?? null),
        barsBottom: stuckBarsBottom(
          bars.map((bar) => {
            const rect = bar.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, stickTop: Number.parseFloat(getComputedStyle(bar).top) };
          }),
        ),
        inDialog,
        inBars,
        fromPointer: pressing,
      });
      if (by !== 0) window.scrollBy({ top: by, behavior: "instant" });
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    document.addEventListener("pointerup", onPointerEnd, { capture: true, passive: true });
    document.addEventListener("pointercancel", onPointerEnd, { capture: true, passive: true });
    document.addEventListener("focusin", onFocusIn, { passive: true });
    return () => {
      clearTimeout(release);
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      document.removeEventListener("pointerup", onPointerEnd, { capture: true });
      document.removeEventListener("pointercancel", onPointerEnd, { capture: true });
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);
  return null;
}
