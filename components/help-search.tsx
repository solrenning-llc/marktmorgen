"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";

// Stable snapshots keep server markup honest before hydration, including when
// application scripts never arrive. No listener, timer, or request is needed.
const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/** Opens the answer a link points at (#can-i-sell-a-course). */
function openFromHash(resetSearch: () => void) {
  let id: string;
  try {
    id = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return;
  }
  const target = id ? document.getElementById(id) : null;
  if (!target?.matches("details[data-help-item], section[data-help-section]")) return;
  // A link must remain reachable even when the current search hid its section.
  resetSearch();
  if (target instanceof HTMLDetailsElement) {
    target.open = true;
  }
  target.scrollIntoView({ block: "start" });
}

/** Shows only the answers that mention every word typed, opened, and says how many. */
function narrow(query: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const items = Array.from(document.querySelectorAll<HTMLDetailsElement>("details[data-help-item]"));
  let count = 0;
  for (const item of items) {
    const match = words.every((w) => (item.textContent ?? "").toLowerCase().includes(w));
    item.hidden = words.length > 0 && !match;
    if (words.length > 0) item.open = match;
    if (match) count += 1;
  }
  for (const section of Array.from(document.querySelectorAll<HTMLElement>("section[data-help-section]"))) {
    section.hidden = words.length > 0 && !section.querySelector("details[data-help-item]:not([hidden])");
  }
  return words.length > 0 ? count : null;
}

/**
 * Narrows the help centre to the answers that mention what was typed. Without
 * JavaScript the whole list is simply there, so nothing depends on this.
 */
export function HelpSearch() {
  const interactive = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<number | null>(null);
  const hint = useId();

  useEffect(() => {
    const reveal = () => openFromHash(() => {
      setQuery("");
      setShown(narrow(""));
    });
    const followCurrentHash = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link || link.hasAttribute("download")) return;
      const target = link.getAttribute("target");
      if (target && target !== "_self") return;
      const href = link.getAttribute("href");
      // The browser does not emit hashchange when the same link is followed twice.
      if (href?.startsWith("#") && href === window.location.hash) reveal();
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    document.addEventListener("click", followCurrentHash);
    return () => {
      window.removeEventListener("hashchange", reveal);
      document.removeEventListener("click", followCurrentHash);
    };
  }, []);

  const search = (value: string) => {
    setQuery(value);
    setShown(narrow(value));
  };

  return (
    <div className="mt-8 max-w-2xl">
      <label htmlFor="help-search" className="sr-only">
        Search the help center
      </label>
      {/*
        The field is the first thing on the page for a reason: most people
        arrive with one question, not with an appetite for forty answers. It
        is set at the size of a primary control rather than a form input, and
        the magnifier is decorative — the label and the input type already say
        what it is.
      */}
      <div className="relative">
        <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-mute">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" />
          </svg>
        </span>
        <input
          id="help-search"
          disabled={!interactive}
          type="search"
          value={query}
          onChange={(e) => search(e.target.value)}
          placeholder="Search: refunds, courses, domain, Stripe…"
          aria-describedby={hint}
          autoComplete="off"
          className="field field-search w-full bg-white shadow-[var(--shadow-sm)]"
        />
      </div>
      <p id={hint} className="mt-3 text-sm text-ink-mute" aria-live="polite">
        {!interactive
          ? "All answers are below. Open a question to read its answer."
          : shown === null
          ? "Type a word and the answers that mention it open below."
          : shown === 0
            ? "No answer mentions that yet. Write to us at the bottom of the page, and a person will answer."
            : `${shown} ${shown === 1 ? "answer" : "answers"} below.`}
      </p>

      {/* The questions people actually arrive with, one tap away. */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-mute">Asked most:</span>
        {["refund", "Stripe", "trial", "course", "domain"].map((word) => (
          <button
            key={word}
            type="button"
            disabled={!interactive}
            onClick={() => search(word)}
            className="chip transition-colors hover:border-line-strong hover:text-ink"
          >
            {word}
          </button>
        ))}
      </div>
    </div>
  );
}
