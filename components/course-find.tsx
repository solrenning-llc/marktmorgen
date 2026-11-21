"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useHydrated } from "@/components/use-hydrated";
import { lessonMatches, queryWords, FIND_MAX_CHARS, FIND_SAY_AFTER_MS } from "@/lib/lesson-find-rules";
import { coursesWords } from "@/lib/buyer-words/courses";
import type { LanguageCode } from "@/lib/store-language";

/**
 * "Find a lesson" above a course's outline (291 [SQ2], unit 1). Each lesson
 * of the outline (components/course-outline.tsx) carries its words in
 * `data-find` (its title and its module's title together); typing keeps only
 * the lessons whose words hold every word typed, and
 * a module with none left is hidden with them. A status line says how many
 * match, or that none does. Emptying the box shows the whole outline again.
 * Nothing is sent anywhere. Drawn only once scripts run; before that, or
 * without them, the outline is all there, as it always was.
 */
export function CourseFind({ language = "en", children }: { language?: LanguageCode; children?: ReactNode }) {
  const words = coursesWords(language);
  const ready = useHydrated();
  const area = useRef<HTMLDivElement>(null);
  const id = useId();
  const [said, setSaid] = useState("");
  // The count is said once typing pauses, not after every letter (4.1.3 without the noise).
  const wait = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(wait.current), []);

  const find = (query: string) => {
    const wanted = queryWords(query);
    const root = area.current;
    if (!root) return;
    let shown = 0;
    root.querySelectorAll<HTMLElement>("[data-find]").forEach((lesson) => {
      const keep = lessonMatches(wanted, lesson.dataset.find ?? "");
      lesson.hidden = !keep;
      if (keep) shown += 1;
    });
    root.querySelectorAll<HTMLElement>("[data-find-module]").forEach((unit) => {
      const lessons = unit.querySelectorAll<HTMLElement>("[data-find]");
      unit.hidden = wanted.length > 0 && (lessons.length === 0 || [...lessons].every((lesson) => lesson.hidden));
    });
    const line = wanted.length === 0 ? "" : shown ? words.findMatches(shown) : words.findNone(query.trim().slice(0, FIND_MAX_CHARS));
    clearTimeout(wait.current);
    wait.current = setTimeout(() => setSaid(line), FIND_SAY_AFTER_MS);
  };

  return (
    <div ref={area}>
      {ready ? (
        <div className="mb-4">
          <label htmlFor={`${id}-find`} className="st-label block">{words.findLabel}</label>
          <input
            id={`${id}-find`}
            type="search"
            className="st-field mt-1 w-full"
            maxLength={FIND_MAX_CHARS}
            autoComplete="off"
            onChange={(e) => find(e.target.value)}
          />
          <p role="status" className="st-muted mt-1 min-h-5 text-sm">{said}</p>
        </div>
      ) : null}
      {children}
    </div>
  );
}
