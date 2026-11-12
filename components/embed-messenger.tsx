"use client";

import { useEffect } from "react";
import type { FrameMessage } from "@/lib/embed-sites";

/**
 * What a frame opened by the checkout script tells the page that opened it
 * (lib/embed-sdk.ts turns each into an event there).
 *
 * Only ever to `to`, one origin the page checked against the store's listed
 * sites (lib/embed-sites.ts listedSite) before drawing this: the browser
 * delivers a message to that origin or drops it, so a page on any other
 * address hears nothing, whatever frames it. Nothing is taken from the page
 * that opened it: this listens to no message.
 *
 *   ready     on arrival, with the height the card asks for
 *   checkout  when the buy button's form is sent (it opens Stripe in a new tab)
 *   optin     on the sign-up form's answer page, with what happened
 *   close     when Escape is pressed inside the frame
 *
 * With closeOnly (lib/embed-open.ts, ScriptOpen.closeTo: a frame that shows the plain link, on a site the creator did
 * not list, a resting store or past the open limit), only "close", on Escape: the script put the focus in the frame,
 * so without it Escape would leave the overlay open (WCAG 2.1.1, 2.1.2). Nothing else is said there.
 */
export function EmbedMessenger({ to, height, status, closeOnly }: { to: string; height?: number; status?: string; closeOnly?: boolean }) {
  useEffect(() => {
    if (window.parent === window) return;
    const say = (type: FrameMessage, more: Record<string, unknown> = {}) => {
      try {
        window.parent.postMessage({ marktmorgen: 1, type, ...more }, to);
      } catch {
        // A parent that is gone hears nothing; the frame still works.
      }
    };
    if (!closeOnly) {
      say("ready", height ? { height } : {});
      if (status) say("optin", { status });
    }
    const sent = (event: Event) => {
      const form = event.target;
      if (!closeOnly && form instanceof HTMLFormElement && form.hasAttribute("data-checkout")) say("checkout");
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") say("close");
    };
    document.addEventListener("submit", sent);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("submit", sent);
      document.removeEventListener("keydown", key);
    };
  }, [to, height, status, closeOnly]);
  return null;
}
