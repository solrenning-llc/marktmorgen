"use client";

import { useEffect, useRef } from "react";
import { forgetAllQuizDrafts, sweepQuizDrafts } from "@/lib/quiz-keep-rules";

/**
 * Drawn on every lesson and on the library, for anyone who opens them: removes
 * from this browser every quiz draft that is old or unreadable, for any lesson
 * or student (lib/quiz-keep-rules.ts sweepQuizDrafts; review of #4324). Draws
 * nothing.
 */
export function QuizSweep() {
  useEffect(() => {
    try {
      sweepQuizDrafts(window.localStorage, Date.now());
    } catch {
      // Storage blocked: nothing was kept there either.
    }
  }, []);
  return null;
}

/** Drawn on the page signing out ends on: removes every quiz draft from this browser, device and tab (forgetAllQuizDrafts). Draws nothing. */
export function ForgetQuizDrafts() {
  useEffect(() => {
    // On the device, where the student chose to keep one, and in this tab.
    for (const area of ["localStorage", "sessionStorage"] as const) {
      try {
        forgetAllQuizDrafts(window[area]);
      } catch {
        // Storage blocked: nothing was kept there either.
      }
    }
  }, []);
  return null;
}

/**
 * Ties `form` to removing every quiz draft from `areas` once it is sent, before the browser leaves; the returned
 * function unties it. A storage that throws does not keep another's drafts. Used by ForgetQuizDraftsOnSubmit.
 */
export function forgetDraftsOnSubmit(form: EventTarget, areas: () => Storage[]): () => void {
  const forget = () => {
    let found: Storage[] = [];
    try {
      found = areas();
    } catch {
      // Storage blocked: nothing was kept there either.
    }
    for (const area of found) {
      try {
        forgetAllQuizDrafts(area);
      } catch {
        // Storage blocked: nothing was kept there either.
      }
    }
  };
  form.addEventListener("submit", forget);
  return () => form.removeEventListener("submit", forget);
}

/**
 * Drawn inside the form a student signs out of a store's pass with (app/[handle]/community/you/page.tsx), which lands
 * on the store and never on the page signing out of an account ends on: sending it removes every quiz draft from this
 * browser first, device and tab, as ForgetQuizDrafts does there (Claude 6's LEVE on #4324). A draft is only ever
 * written by a script, so a browser without one has none to remove. Draws nothing a person sees.
 */
export function ForgetQuizDraftsOnSubmit() {
  const here = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = here.current?.closest("form");
    if (!form) return;
    return forgetDraftsOnSubmit(form, () => [window.localStorage, window.sessionStorage]);
  }, []);
  return <span ref={here} hidden />;
}
