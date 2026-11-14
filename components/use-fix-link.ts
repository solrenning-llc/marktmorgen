"use client";

import { useEffect, useRef } from "react";
import { browserFrames, focusWhenDrawn } from "@/lib/focus-when-drawn";

/**
 * A warning's fix in one click (AX274 Part A item 6): a link such as
 * `#alt-<product id>` in the studio's checks, answered by the editor that holds
 * the item. When the creator presses it, `open` opens that item (a closed
 * product, a link's form) and names the field to fill; the focus goes there once
 * it is drawn. Nothing opens before the press and nothing is written: the creator
 * fills the field and saves. An item this editor does not hold (`open` answers
 * null) is left to the link as it is.
 */
export function useFixLink(prefix: string, open: (id: string) => string | null): void {
  const latest = useRef(open);
  useEffect(() => {
    latest.current = open;
  });
  useEffect(() => {
    let stop: (() => void) | null = null;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.(`a[href^="#${prefix}"]`);
      if (!anchor) return;
      const id = (anchor.getAttribute("href") ?? "").slice(prefix.length + 1);
      if (!id) return;
      const field = latest.current(id);
      if (!field) return;
      event.preventDefault();
      stop?.();
      stop = focusWhenDrawn(() => document.getElementById(field), browserFrames());
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      stop?.();
    };
  }, [prefix]);
}
