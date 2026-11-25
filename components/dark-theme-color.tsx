"use client";

import { useEffect } from "react";
import { SCHEME_ATTRIBUTE, themeColorFor } from "@/lib/dark-tokens";

/**
 * On a dark-ready screen, the browser's own chrome (its theme color) follows the reader's scheme: the studio layout
 * says white, and a reader who chose dark gets the dark paper instead, also when they switch while the screen is open
 * (Codex N1 LOW on #3561). It only reads the attribute, never sets it. Puts the layout's color back when the screen is
 * left. Draws nothing.
 */
export function DarkThemeColor() {
  useEffect(() => {
    const root = document.documentElement;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const before = meta.content;
    const apply = () => {
      meta.content = themeColorFor(root.getAttribute(SCHEME_ATTRIBUTE) ?? undefined);
    };
    apply();
    const watch = new MutationObserver(apply);
    watch.observe(root, { attributes: true, attributeFilter: [SCHEME_ATTRIBUTE] });
    return () => {
      watch.disconnect();
      meta.content = before;
    };
  }, []);
  return null;
}
