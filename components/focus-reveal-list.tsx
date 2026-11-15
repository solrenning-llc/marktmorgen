"use client";

import type { ReactNode } from "react";
import { revealFocused } from "@/components/reveal-focus";

/**
 * A <ul> for a server page whose row of links scrolls sideways on a phone: a link reached by Tab is brought wholly
 * into view (components/reveal-focus.ts). Without JavaScript it is a plain list, scrolled the browser's own way.
 */
export function FocusRevealList({ className, children }: { className: string; children: ReactNode }) {
  return (
    <ul className={className} onFocus={revealFocused}>
      {children}
    </ul>
  );
}
