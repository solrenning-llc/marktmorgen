"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";

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
 */
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
  const on = useSyncExternalStore(subscribe, stored, onServer);
  // Said only after a press, so a screen reader hears the change, never on the first draw.
  const [said, setSaid] = useState("");
  return (
    <div data-focus={on ? "on" : "off"} className="group/focus">
      {ready ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold"
            onClick={() => {
              setSaid(on ? words.focusOffSaid : words.focusOnSaid);
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
