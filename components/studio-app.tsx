"use client";

import { useEffect } from "react";
import { focusKeeper, type KeeperPlace, type KeptElement } from "@/lib/focus-keeper";

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
  // A control turned off while it works (disabled={busy}) gets the focus back once it is on again; one moved gets it
  // back at once; one taken away hands it to the first control of the nearest part of the main content still there.
  // Only while the focus was left on the page's body (lib/focus-keeper.ts; WCAG 2.4.3).
  useEffect(() => {
    const keeper = focusKeeper(() => document.activeElement, document.body, STUDIO_PLACE);
    const element = (target: EventTarget | null) => (target instanceof HTMLElement ? (target as HTMLElement & KeptElement) : null);
    const onIn = (event: FocusEvent) => {
      const target = element(event.target);
      if (target) keeper.focusIn(target);
    };
    const onOut = (event: FocusEvent) => {
      const target = element(event.target);
      if (target) keeper.focusOut(target);
    };
    const onPointer = (event: PointerEvent) => keeper.pointerDown(element(event.target));
    const watch = new MutationObserver((records) => {
      let tree = false;
      const added: (HTMLElement & KeptElement)[] = [];
      for (const record of records) {
        if (record.type === "childList") {
          tree = true;
          for (const node of record.addedNodes) if (node instanceof HTMLElement) added.push(node as HTMLElement & KeptElement);
          continue;
        }
        const target = element(record.target);
        if (target) keeper.disabledChanged(target);
      }
      if (tree) keeper.treeChanged(added);
    });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"] });
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      watch.disconnect();
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);
  return null;
}

/** A control the keyboard reaches, in the order a person meets them; a field first, as an editor opened in a button's place starts with one. */
const FIELDS = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])';
const CONTROLS = 'button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';
const shown = (node: Element) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";

/** Where the keeper looks once a control was taken away: only inside the page's main content, never the main region itself. */
const STUDIO_PLACE: KeeperPlace = {
  inMain: (part) => part instanceof Element && part.tagName !== "MAIN" && part.closest("main") !== null,
  firstControlIn: (part) => {
    if (!(part instanceof Element)) return null;
    const first = (selector: string) => [...part.querySelectorAll<HTMLElement>(selector)].find(shown) ?? null;
    // The part itself may be the control (a button added on its own).
    if (part instanceof HTMLElement && part.matches(`${FIELDS}, ${CONTROLS}`) && shown(part)) return part as HTMLElement & KeptElement;
    return (first(FIELDS) ?? first(CONTROLS)) as (HTMLElement & KeptElement) | null;
  },
  contains: (outer, inner) => outer instanceof Node && inner instanceof Node && outer.contains(inner),
};
