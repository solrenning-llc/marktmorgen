"use client";

import { useEffect } from "react";
import { forgetLastIn, lastKey, writeLast } from "@/lib/lesson-position-rules";

/**
 * Drawn on a lesson page for a signed-in student: keeps this lesson, on their
 * own device, as the last one they opened, so their library can offer it back
 * (650 [WG10], unit 2, lib/lesson-position-rules.ts). Draws nothing; nothing
 * is sent to us. Storage blocked or full: nothing kept, the lesson works the same.
 */
export function RememberLastLesson({ person, path, courseId, lesson, course, store }: { person: string; path: string; courseId: string; lesson: string; course: string; store: string }) {
  useEffect(() => {
    const key = lastKey(person);
    const value = writeLast({ path, courseId, lesson, course, store }, Date.now());
    if (!key || !value) return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Blocked or full: nothing kept.
    }
  }, [person, path, courseId, lesson, course, store]);
  return null;
}

/**
 * Drawn on a course's page when the student's access is not confirmed (a refund, a lost dispute, an ended
 * membership, or a check that could not be made): removes this student's last lesson from the device when it is in
 * this course, as components/forget-lesson-positions.tsx removes their places. Draws nothing.
 */
export function ForgetLastLesson({ courseId, person }: { courseId: string; person: string }) {
  useEffect(() => {
    try {
      forgetLastIn(window.localStorage, person, courseId, Date.now());
    } catch {
      // Storage blocked: nothing was kept there either.
    }
  }, [courseId, person]);
  return null;
}
