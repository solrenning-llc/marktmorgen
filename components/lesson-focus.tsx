"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

/**
 * "Focus mode" on a lesson's page (295 [SQ6]; added 12 November 2026). One
 * button hides everything around the lesson: the trail to the course, the
 * course outline, the student's notes, the comments and the links to the
 * lessons before and after. The lesson itself, its player, its quiz or task
 * and "Mark as done" stay. The same button, in the same place, says how to
 * leave, so the keyboard focus never moves and nothing has to be found again.
 *
 * Whatever is hidden carries `group-data-[focus=on]/focus:hidden`, read from
 * the wrapper drawn here. Nothing moves or fades: there is no animation to
 * reduce. The choice is kept only in this browser (localStorage, or in memory
 * when the browser refuses), never sent anywhere. Before scripts run, or
 * without them, the button is not offered, because it could not work (VR 2).
 *
 * A link to something focus mode hides (the reply link in a comment email,
 * #c-<id>, review of #4323) opens the lesson with focus mode off for that
 * visit and scrolls to it, so the link is never a blank page; the remembered
 * choice is left as it was until the student presses the button.
 */
/** Whatever focus mode hides carries this in its class (group-data-[focus=on]/focus:hidden). */
export const HIDDEN_IN_FOCUS = '[class*="group-data-[focus=on]/focus:hidden"]';

/** Whether the address's #target is an element that focus mode hides inside `area`. */
export function hashHiddenInFocus(area: { contains: (node: Element) => boolean } | null, hash: string, byId: (id: string) => Element | null): Element | null {
  if (!area || hash.length < 2) return null;
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
  const target = byId(id);
  return target && area.contains(target) && target.closest(HIDDEN_IN_FOCUS) ? target : null;
}
export const FOCUS_KEY = "mm:lesson-focus";

export type FocusWords = { focusOn: string; focusOff: string; focusOnSaid: string; focusOffSaid: string };

let memory: boolean | null = null;
const listeners = new Set<() => void>();

function stored(): boolean {
  if (memory !== null) return memory;
  try {
    return window.localStorage.getItem(FOCUS_KEY) === "on";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const fromOtherTab = (event: StorageEvent) => {
    if (event.key !== FOCUS_KEY) return;
    memory = null;
    listener();
  };
  window.addEventListener("storage", fromOtherTab);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", fromOtherTab);
  };
}

/** Switches focus mode on or off in this browser, for every lesson. */
export function setFocus(on: boolean): void {
  memory = on;
  try {
    window.localStorage.setItem(FOCUS_KEY, on ? "on" : "off");
  } catch {
    // Kept in memory for this visit only.
  }
  for (const listener of listeners) listener();
}

const noStore = () => () => {};
const onClient = () => true;
const onServer = () => false;

export function LessonFocus({ words, children }: { words: FocusWords; children?: ReactNode }) {
  const ready = useSyncExternalStore(noStore, onClient, onServer);
  const remembered = useSyncExternalStore(subscribe, stored, onServer);
  // Off for this visit, whatever is remembered, while the address points at something focus mode hides.
  const [visitOff, setVisitOff] = useState(false);
  const on = remembered && !visitOff;
  // Said only after a press, so a screen reader hears the change, never on the first draw.
  const [said, setSaid] = useState("");
  const area = useRef<HTMLDivElement>(null);
  const goTo = useRef<Element | null>(null);
  useEffect(() => {
    const check = () => {
      const target = hashHiddenInFocus(area.current, window.location.hash, (id) => document.getElementById(id));
      if (!target) return;
      goTo.current = target;
      setVisitOff(true);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);
  useEffect(() => {
    // Once shown, the target the browser could not reach while hidden is brought into view.
    if (!visitOff || !goTo.current) return;
    goTo.current.scrollIntoView();
    goTo.current = null;
  }, [visitOff]);
  return (
    <div ref={area} data-focus={on ? "on" : "off"} className="group/focus">
      {ready ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold"
            onClick={() => {
              setSaid(on ? words.focusOffSaid : words.focusOnSaid);
              setVisitOff(false);
              setFocus(!on);
            }}
          >
            {on ? words.focusOff : words.focusOn}
          </button>
          <p role="status" className="sr-only">{said}</p>
        </div>
      ) : null}
      {children}
    </div>
  );
}
