/**
 * How far the page scrolls when a control takes focus under the studio's sticky header and section bar (#3757).
 *
 * Chromium and Firefox scroll a focused control clear of the bars on their own (scroll-padding-top, app/globals.css),
 * so the rule answers 0 there. WebKit does not apply scroll-padding to focus scrolling: a control focused under the
 * bars stayed covered (WCAG 2.4.11 AA, 2.4.12 AAA; Cross-browser (webkit 3/3), job 135916797836). The handler in
 * components/studio-focus-clear.tsx only scrolls the page by this amount: it never moves focus or the tab order.
 * Pure: the handler reads the rects.
 */

/** Room above a focused control for its focus ring: 124 px of bars plus this is the 8.5rem of scroll-padding-top. */
export const FOCUS_CLEAR_ROOM = 12;

export type FocusClearInput = Readonly<{
  /** The focused control's top, in viewport pixels (getBoundingClientRect). */
  controlTop: number;
  /** The lowest bottom of the sticky header and section bar, in viewport pixels; null when none is sticky. */
  barsBottom: number | null;
  /** The control is inside a dialog, which sits above the page and is never scrolled for. */
  inDialog: boolean;
  /** The control is one of the bars' own, which are always in view. */
  inBars: boolean;
  /**
   * The focus came with a mouse or touch press still under way: the press already put the pointer on the control, and
   * moving the page before it ends would carry the click away (a hidden radio under the bars stayed unchecked, #3757).
   */
  fromPointer: boolean;
}>;

/**
 * The scroll the page needs, in pixels (negative: up), so a focused control sits clear of the bars with its ring's
 * room; 0 when it already does, when no bar is sticky (print, forced reflow), inside a dialog or a bar, during a
 * pointer press, or when a reading is not a finite number.
 */
export function focusScrollBy(input: FocusClearInput): number {
  const { controlTop, barsBottom, inDialog, inBars, fromPointer } = input;
  if (fromPointer || inDialog || inBars || barsBottom === null) return 0;
  if (!Number.isFinite(controlTop) || !Number.isFinite(barsBottom) || barsBottom <= 0) return 0;
  return controlTop < barsBottom ? controlTop - barsBottom - FOCUS_CLEAR_ROOM : 0;
}

/**
 * The top of what a person sees for a focused control: the control itself, or, when it is visually hidden (a 1 px or
 * empty box, as an sr-only radio inside its label), its visible label. A hidden control with no label gives NaN, no
 * reading, so the rule answers 0: there is nothing on screen to bring clear.
 */
export function visibleTop(own: Readonly<{ top: number; width: number; height: number }>, label: Readonly<{ top: number }> | null): number {
  if (own.width > 1 && own.height > 1) return own.top;
  return label ? label.top : Number.NaN;
}

/**
 * The lowest bottom of the sticky bars that are stuck right now, in viewport pixels, or null when none is. A bar is
 * read only while it sits at its own sticky top (its rect's top within a pixel of the computed `top`): a sticky
 * <header> lower in the page that has not reached its place yet covers nothing at the top of the viewport. Every
 * sticky header and section bar counts, never only the first <header> in the document (Claude 5's LOW on #3757).
 */
export function stuckBarsBottom(bars: ReadonlyArray<Readonly<{ top: number; bottom: number; stickTop: number }>>): number | null {
  // RED: the old reading, the first bar only.
  return bars.length === 0 ? null : bars[0].bottom;
}
