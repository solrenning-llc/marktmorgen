/**
 * Keeps the keyboard's focus on a control that is turned off while it works
 * (AX274 Part A; WCAG 2.2 2.4.3 Focus Order). Across the studio, a button that
 * sends something takes disabled={busy} until the answer comes back (232
 * controls in 93 components on 11 November 2026). A browser moves the focus of
 * a control that is turned off to the page's body, and does not bring it back
 * when the control is on again, so the next Tab started from the top of the
 * page and a screen reader lost its place.
 *
 * The keeper hears where the focus goes and which controls are turned off and
 * on. When the control that had the focus is turned on again and the focus is
 * still nowhere (the body, or no element), the focus goes back to it. It never
 * takes the focus from anything else: a person who moved on keeps their place,
 * a control left on purpose before it was turned off is not taken back, and a
 * control that has left the page is not focused.
 *
 * Pure apart from what it is given, so tests/focus-keeper.test.ts drives it
 * with its own elements; components/studio-app.tsx wires it to the document.
 */

export type KeptElement = {
  disabled?: boolean;
  isConnected: boolean;
  focus: (options?: { preventScroll?: boolean }) => void;
};

export type FocusKeeper = {
  /** The focus arrived on an element (a focusin event). */
  focusIn: (element: KeptElement) => void;
  /** The focus left an element (a focusout event). */
  focusOut: (element: KeptElement) => void;
  /** An element's disabled attribute changed (a MutationObserver record). */
  disabledChanged: (element: KeptElement) => void;
};

/** `active` reads the document's active element; `body` is the page's body, where a browser leaves a lost focus. */
export function focusKeeper(active: () => unknown, body: unknown): FocusKeeper {
  // The element that has, or last had, the focus while it was on; null once it was left on purpose.
  let last: KeptElement | null = null;
  // The element turned off under the focus, waiting to be on again.
  let waiting: KeptElement | null = null;
  const nowhere = () => {
    const now = active();
    return now === body || now === null || now === undefined;
  };
  return {
    focusIn(element) {
      last = element;
      waiting = null;
    },
    focusOut(element) {
      // Left while still on: a click elsewhere, a Tab. Left because it was turned off: kept.
      if (element === last && !element.disabled) last = null;
    },
    disabledChanged(element) {
      if (element.disabled) {
        if (element === last) waiting = element;
        return;
      }
      if (element !== waiting) return;
      waiting = null;
      if (element.isConnected && nowhere()) element.focus({ preventScroll: true });
    },
  };
}
