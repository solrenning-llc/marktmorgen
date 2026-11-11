/**
 * Keeps the keyboard's focus where the person is working when the studio
 * changes the page under it (AX274 Part A; WCAG 2.2 2.4.3 Focus Order). A
 * browser moves a lost focus to the page's body and never brings it back, so
 * the next Tab started from the top of the page and a screen reader lost its
 * place. Three ways it was lost, seen on 11 November 2026:
 *
 * 1. Turned off while it works: a button that sends something takes
 *    disabled={busy} until the answer comes back (232 controls in 93
 *    components). Once it is on again, the focus goes back to it.
 * 2. Moved: "Move … up" moves the part of the page the focus is in. The
 *    control is still on the page, so the focus goes back to it.
 * 3. Taken away: about twenty buttons on the studio's start page open an
 *    editor in their own place ("Add your profiles", "Change my address",
 *    "Offer a payment plan"…). The focus goes to the first control of what
 *    the change added in the nearest part of the page still there (the editor
 *    that took the button's place), else to that part's first control; only
 *    inside the page's main content (`inMain`), never when the page itself was
 *    replaced by a navigation.
 *
 * It only acts while the focus is nowhere (the body, or no element). It never
 * takes the focus from anything else: a person who moved on keeps their
 * place (the focus arrived somewhere else), and a control left on purpose (a
 * click or a touch elsewhere) is not taken back. A blur alone does not say a
 * person left: Chromium sends blur and focusout to a button still on the page,
 * a moment before React takes it away. Pure apart from what it is given, so tests/focus-keeper.test.ts and
 * tests/focus-keeper-removed.test.ts drive it with their own elements;
 * components/studio-app.tsx wires it to the document.
 */

export type KeptElement = {
  disabled?: boolean;
  isConnected: boolean;
  parentElement?: KeptElement | null;
  focus: (options?: { preventScroll?: boolean }) => void;
};

/** Where to look once a control was taken away: whether a part of the page is inside its main content, its first control, and whether one element holds another. */
export type KeeperPlace = {
  inMain: (element: KeptElement) => boolean;
  firstControlIn: (element: KeptElement) => KeptElement | null;
  contains: (outer: KeptElement, inner: KeptElement) => boolean;
};

export type FocusKeeper = {
  /** The focus arrived on an element (a focusin event). */
  focusIn: (element: KeptElement) => void;
  /** The focus left an element (a focusout event). Not a person leaving it on its own: see pointerDown. */
  focusOut: (element: KeptElement) => void;
  /** A click or a touch somewhere (a pointerdown event): a person leaving the control on purpose. */
  pointerDown: () => void;
  /** An element's disabled attribute changed (a MutationObserver attributes record). */
  disabledChanged: (element: KeptElement) => void;
  /** Elements were added or taken away somewhere (MutationObserver childList records), with the elements added. */
  treeChanged: (added?: KeptElement[]) => void;
};

/** How many parts up the page the keeper looks for what a change added (an editor in a button's place). */
const NEAR_ADDED = 6;
/** How many parts up the page it looks for a control when nothing was added near the one taken away. */
const NEAR = 3;

/** `active` reads the document's active element; `body` is the page's body, where a browser leaves a lost focus. */
export function focusKeeper(active: () => unknown, body: unknown, place?: KeeperPlace): FocusKeeper {
  // The element that has, or last had, the focus while it was on; null once it was left on purpose.
  let last: KeptElement | null = null;
  // Its parts of the page, nearest first, read when it got the focus: once it is taken away it has no parent.
  let around: KeptElement[] = [];
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
      around = [];
      for (let at = element.parentElement; at; at = at.parentElement) around.push(at);
    },
    focusOut() {
      // Nothing to do: a Tab brings a focusin elsewhere, and a click a pointerdown first. A blur alone also comes to
      // a control being turned off, moved or taken away, which is when the focus must go on.
    },
    pointerDown() {
      last = null;
      waiting = null;
      around = [];
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
    treeChanged(added = []) {
      if (last === null || !nowhere()) return;
      if (last.isConnected) {
        // Moved, not taken away. One that is off waits to be on again (disabledChanged).
        if (!last.disabled) last.focus({ preventScroll: true });
        return;
      }
      if (!place) return;
      const lost = last;
      const parts = around.filter((part) => part.isConnected);
      // The page itself was replaced: a navigation brings its own focus.
      if (parts.length === 0 || !place.inMain(parts[0])) return;
      const inside = parts.filter((part) => place.inMain(part));
      // First, what the change added in the nearest part that holds any of it: the editor that took the control's
      // place, beside it or a level up (a goal's form beside its title row), and after other controls of that part (a
      // product card's waitlist box before its shipping editor).
      for (const part of inside.slice(0, NEAR_ADDED)) {
        const fresh = added.filter((node) => node.isConnected && place.contains(part, node));
        if (fresh.length === 0) continue;
        const next = fresh.map((node) => place.firstControlIn(node)).find((control) => control !== null && control !== lost);
        if (next) {
          next.focus({ preventScroll: true });
          return;
        }
      }
      // Nothing added near it: the first control of the nearest part that has one, a few levels up at most, never an
      // unrelated control far up the page.
      for (const part of inside.slice(0, NEAR)) {
        const next = place.firstControlIn(part);
        if (next && next !== lost) {
          next.focus({ preventScroll: true });
          return;
        }
      }
    },
  };
}
