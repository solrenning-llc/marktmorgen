"use client";

import { useEffect } from "react";

// One navigation confirmation covers every dirty editor on the page.
const checkedNavigation = new WeakSet<MouseEvent>();

const ASK = "You have changes that are not saved. Leave without saving them?";

/**
 * Asks before unsaved work is left behind (added 8 October 2026): closing
 * or reloading the tab, and following a link inside the site, which a
 * browser alone does not ask about. Only while `dirty`; never on a link that
 * opens a new tab, jumps within the page or is pressed with a key held to
 * open it elsewhere. A page in a store's language passes that language's
 * `ask`; the studio's editors keep the English one.
 */
export function useLeaveGuard(dirty: boolean, ask: string = ASK): void {
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when a value is set; the words are their own.
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const to = new URL(link.href, window.location.href);
      if (to.origin !== window.location.origin) return;
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;
      if (checkedNavigation.has(event)) return;
      checkedNavigation.add(event);
      if (!window.confirm(ask)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onUnload);
    // Before the router's own handler, so a "stay" keeps the page where it is.
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, ask]);
}
