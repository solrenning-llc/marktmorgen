"use client";

import { useEffect, useId, useSyncExternalStore } from "react";
import { COLOR_SCHEME_CHOICES, COLOR_SCHEME_KEY, COLOR_SCHEME_LABELS, DARK_QUERY, type ColorSchemeChoice, isDark, toChoice } from "@/lib/color-scheme";

/*
 * The reader's choice of "Light", "Dark" or "Match my device" (274 [AX1], dark mode stage 2). Three native radio
 * buttons in a fieldset: the legend names the group, each label names its button, the browser announces which one is
 * checked, and Tab enters the group at the checked one while the arrow keys move and check (the keyboard of the
 * WAI-ARIA APG Radio Group pattern, w3.org/WAI/ARIA/apg/patterns/radio, read 10 November 2026, which native radio
 * buttons give without any ARIA).
 * The choice is kept in this browser's localStorage only and is applied at once; the script in <head>
 * (lib/color-scheme.ts) applies it on the next page before anything is painted.
 */

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab changing the choice changes it here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === COLOR_SCHEME_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function stored(): ColorSchemeChoice {
  try {
    return toChoice(window.localStorage.getItem(COLOR_SCHEME_KEY));
  } catch {
    return "light";
  }
}

/** Draw the page as the choice says, now. "Light" removes the attribute, so the page is exactly the default again. */
function apply(choice: ColorSchemeChoice): void {
  const deviceDark = typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
  const root = document.documentElement;
  if (isDark(choice, deviceDark)) root.setAttribute("data-color-scheme", "dark");
  else root.removeAttribute("data-color-scheme");
}

/** Draw the page as the kept choice says (another tab changed it). Exported for tests/dark-scheme-switch.test.ts. */
export function followStoredChoice(): void {}

/** Keep the choice in this browser and draw the page with it. Exported for tests/dark-scheme-switch.test.ts. */
export function chooseColorScheme(choice: ColorSchemeChoice): void {
  try {
    // Light is the default, so choosing it keeps nothing at all.
    if (choice === "light") window.localStorage.removeItem(COLOR_SCHEME_KEY);
    else window.localStorage.setItem(COLOR_SCHEME_KEY, choice);
  } catch {
    // Storage refused (a private window, a full disk): the choice still holds on this page.
  }
  apply(choice);
  for (const l of listeners) l();
}

export function ColorSchemeSwitch() {
  // Null on the server and in the first render, so the markup matches; the radios wait for the browser.
  const choice = useSyncExternalStore<ColorSchemeChoice | null>(subscribe, stored, () => null);
  const id = useId();

  // "Match my device" follows the device while the page is open.
  useEffect(() => {
    if (choice !== "system" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    const follow = () => apply("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [choice]);

  return (
    <fieldset className="space-y-3" aria-describedby={`${id}-note`}>
      <legend className="font-semibold text-ink">Page colors</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {COLOR_SCHEME_CHOICES.map((value) => (
          <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2.5">
            <input
              type="radio"
              name={`${id}-scheme`}
              value={value}
              checked={choice === value}
              disabled={choice === null}
              onChange={() => chooseColorScheme(value)}
              className="h-5 w-5"
            />
            {COLOR_SCHEME_LABELS[value]}
          </label>
        ))}
      </div>
      <p id={`${id}-note`} className="text-ink-mute">
        Light is the default. Your choice is kept in this browser only and is never sent to us. For now, dark colors are
        used only on some pages, such as this one and our policies; the rest of the site stays light.
      </p>
    </fieldset>
  );
}
