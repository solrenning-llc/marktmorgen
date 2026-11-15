import type { FocusEvent } from "react";

/**
 * Brings a focused control wholly into view inside a list that scrolls sideways (WCAG 2.4.11 and 2.4.12).
 *
 * Chromium scrolls a control that receives keyboard focus only when the control is wholly out of sight, so in a
 * row of links that scrolls sideways on a phone, a link half past the edge got focus with most of it, and its focus
 * ring, cut off (the help center's Sections list at 320 px, 15 November 2026). Put this on the list as `onFocus`:
 * focus events bubble in React, so it hears every control inside. "nearest" moves nothing when the control is
 * already in view and otherwise the least distance; the page's own `scroll-behavior` (and with it the reader's
 * reduced-motion setting) decides whether it glides.
 */
export function revealFocused(event: FocusEvent<HTMLElement>): void {
  const target = event.target as Partial<HTMLElement> | null;
  if (!target || target === event.currentTarget || typeof target.scrollIntoView !== "function") return;
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
}
