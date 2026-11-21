"use client";

import { useEffect } from "react";
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
