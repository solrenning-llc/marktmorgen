"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { MAX_COURSE_QUERY, narrowDom } from "@/lib/course-search";
import { courseSearchWords } from "@/lib/buyer-words/course-search";
import type { LanguageCode } from "@/lib/store-language";

// Stable snapshots: false on the server and before hydration, true once the
// page's script runs. No listener, timer or request is needed.
const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

// How long typing must pause before the count is said: the list narrows at
// every key, but a screen reader hears the count once, not at each letter.
const ANNOUNCE_AFTER_MS = 500;

/**
 * "Find a lesson" (291 [SQ2], lib/course-search.ts): narrows the course's
 * outline, drawn under the element with the id `outline`, to the lessons
 * whose title or module name holds every word typed, and says how many are
 * left. It only hides and shows what the page already drew; it sends nothing.
 *
 * Nothing is drawn until the script runs, so a page without JavaScript shows
 * no box that cannot work, and its whole outline as before. Typing changes
 * the list below, never the page or the focus (WCAG 3.2.5); the count is shown at
 * once and said politely once typing pauses; Escape and the button both
 * empty the field.
 */
export function CourseSearch({ outline, language }: { outline: string; language?: LanguageCode }) {
  const interactive = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<{ matches: number; total: number } | null>(null);
  const [said, setSaid] = useState("");
  const wait = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const field = useId();
  const hint = useId();
  const w = courseSearchWords(language);
  useEffect(
    () => () => {
      if (wait.current) clearTimeout(wait.current);
    },
    [],
  );
  if (!interactive) return null;

  const sentence = (now: { matches: number; total: number } | null) =>
    now === null ? w.idle : now.matches === 0 ? w.none : w.some(now.matches, now.total);
  const search = (value: string) => {
    setQuery(value);
    const root = document.getElementById(outline);
    const now = root ? narrowDom(root, value) : null;
    setShown(now);
    if (wait.current) clearTimeout(wait.current);
    wait.current = setTimeout(() => {
      wait.current = null;
      setSaid(sentence(now));
    }, ANNOUNCE_AFTER_MS);
  };
  const clear = () => {
    search("");
    input.current?.focus();
  };

  return (
    <div role="search" className="mt-4">
      <label htmlFor={field} className="st-label">
        {w.label}
      </label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          ref={input}
          id={field}
          type="search"
          value={query}
          maxLength={MAX_COURSE_QUERY}
          onChange={(e) => search(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              search("");
            }
          }}
          aria-describedby={hint}
          aria-controls={outline}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          className="st-field min-w-0 flex-1"
        />
        {query ? (
          <button type="button" onClick={clear} className="btn st-btn">
            {w.clear}
          </button>
        ) : null}
      </div>
      <p id={hint} className="st-muted mt-2 text-sm">
        {sentence(shown)}
      </p>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
