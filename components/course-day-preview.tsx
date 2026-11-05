"use client";

import { useState } from "react";
import { type Course, isCohort } from "@/lib/course";
import { courseOnDay, dayWords, lastOpeningDay, lessonStateWords, previewMatters } from "@/lib/course-preview";
import { LocalDay } from "@/components/local-day";

/**
 * "What a student sees" (399 [SL3], unit 3): the course on a day the creator
 * picks, by the course page's own rules (lib/course-preview.ts), as a student
 * who has not passed a quiz or handed in work yet. Drawn from the course as
 * the editor holds it, so it follows every saved change; nothing is read,
 * written or sent. Shown only when something depends on the day, a quiz or
 * an assignment.
 *
 * The day's summary is plain text tied to the field, read when the field is
 * reached, never announced on its own: it also changes when a lesson is
 * added elsewhere on the page, which nobody asked to hear about.
 */
export function CourseDayPreview({ course }: { course: Course }) {
  const [typed, setTyped] = useState("0");
  if (!previewMatters(course)) return null;
  const last = lastOpeningDay(course);
  const read = Math.floor(Number(typed));
  const day = typed.trim() !== "" && Number.isFinite(read) && read >= 0 ? read : 0;
  const modules = courseOnDay(course, day);
  const cohort = isCohort(course);
  const summary = dayWords(modules, day, last);
  return (
    <section className="card p-6 sm:p-8" aria-labelledby="course-day-title">
      <h2 id="course-day-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">What a student sees</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Check your schedule as a student who has not passed a quiz or handed in work yet, without buying the course. Nothing is changed and nobody is told.
      </p>
      {last > 0 ? (
        <>
          <label htmlFor="course-day" className="field-label mt-4 block">
            {cohort ? "Days after the course starts" : "Days after a student joins"}
          </label>
          <input
            id="course-day"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            className="field w-32"
            aria-describedby="course-day-hint course-day-summary"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={() => setTyped(String(day))}
          />
          <p id="course-day-hint" className="field-hint mt-1">
            {`Day 0 is the day ${cohort ? "the course starts" : "they join"}. The last module opens on day ${last}.`}
            {cohort ? " Before the start date, only free preview lessons open." : null}
          </p>
        </>
      ) : (
        <p className="field-hint mt-4">
          {cohort ? "Every module opens the day the course starts. Before then, only free preview lessons open." : "Every module opens the day a student joins."}
        </p>
      )}
      <p id="course-day-summary" className="mt-3 text-sm font-semibold text-ink">
        {`Day ${day}`}
        {cohort && course.startsAt !== null ? (
          <>
            {" ("}
            <LocalDay seconds={course.startsAt + day * 86_400} />
            {")"}
          </>
        ) : null}
        {`: ${summary}`}
      </p>
      <ol className="mt-3 space-y-4">
        {modules.map((unit) => (
          <li key={unit.id}>
            <h3 className="font-semibold text-ink">{unit.title}</h3>
            <p className="text-sm text-ink-soft">{unit.open ? "Open" : `Opens on day ${unit.opensOnDay}`}</p>
            {unit.lessons.length ? (
              <ul className="mt-1 space-y-1">
                {unit.lessons.map((lesson) => (
                  <li key={lesson.id} className="text-sm">
                    <span className="text-ink">{lesson.title}</span>
                    <span className="text-ink-soft">{` — ${lessonStateWords(lesson)}`}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-soft">No lessons yet.</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
