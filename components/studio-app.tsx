"use client";

import { useEffect } from "react";
import { focusKeeper, type KeptElement } from "@/lib/focus-keeper";

/** The studio's own service worker and the part of the site it covers. */
export const STUDIO_WORKER = "/studio-sw.js";
export const STUDIO_SCOPE = "/studio";

/**
 * Registers the studio's service worker (public/studio-sw.js) on every studio
 * page, which is what lets a phone install the studio as an app with its own
 * manifest and what shows its notifications. It draws nothing, and waits for
 * the page to load first so the studio never waits on it.
 *
 * Its scope is the studio alone. The site's other worker (public/sw.js)
 * covers the stores and the public pages; for a studio page, the narrower
 * scope wins, so nothing of the studio passes through a worker that caches.
 *
 * It also keeps the keyboard's focus on a control turned off while it works
 * (lib/focus-keeper.ts), on every studio page.
 */
export function StudioApp() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register(STUDIO_WORKER, { scope: STUDIO_SCOPE }).catch(() => {});
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  // A control turned off while it works (disabled={busy}) gets the focus back once it is on again, if the focus was
  // left on the page's body meanwhile (lib/focus-keeper.ts; WCAG 2.4.3).
  useEffect(() => {
    const keeper = focusKeeper(() => document.activeElement, document.body);
    const element = (target: EventTarget | null) => (target instanceof HTMLElement ? (target as HTMLElement & KeptElement) : null);
    const onIn = (event: FocusEvent) => {
      const target = element(event.target);
      if (target) keeper.focusIn(target);
    };
    const onOut = (event: FocusEvent) => {
      const target = element(event.target);
      if (target) keeper.focusOut(target);
    };
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        const target = element(record.target);
        if (target) keeper.disabledChanged(target);
      }
    });
    watch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      watch.disconnect();
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  return null;
}
