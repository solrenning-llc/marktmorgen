"use client";

import { useEffect } from "react";
import { forgetCoursePlaces } from "@/lib/lesson-position-rules";

/**
 * Drawn on a course's page when the student's access has ended (a refund, a
 * lost dispute, a membership that ended): removes from this device every
 * place they kept in the course's videos (650 [WG10],
 * lib/lesson-position-rules.ts). Draws nothing.
 */
export function ForgetLessonPositions({ courseId, learner }: { courseId: string; learner: string }) {
  useEffect(() => {
    try {
      forgetCoursePlaces(window.localStorage, courseId, learner);
    } catch {
      // Storage blocked: nothing was kept there either.
    }
  }, [courseId, learner]);
  return null;
}
