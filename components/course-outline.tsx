import Link from "next/link";
import type { Course } from "@/lib/course";
import { isCohort, isOpen, opensAt } from "@/lib/course";
import { LocalDay } from "@/components/local-day";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";

/**
 * A sentence with "{day}" in it, the day drawn in the reader's own time zone
 * (components/local-day.tsx).
 */
export function WithDay({ text, seconds, locale }: { text: string; seconds: number; locale: string }) {
  const [before, after = ""] = text.split("{day}");
  return (
    <>
      {before}
      <LocalDay seconds={seconds} locale={locale} />
      {after}
    </>
  );
}

/**
 * The course as a list: modules, their lessons, and for this visitor what is
 * done, what is open, what opens when, and what can be watched for free.
 * Said in the store's `language` (lib/buyer-words/courses.ts), English unless
 * given. The data-find-* marks are what "Find a lesson" narrows
 * (lib/course-search.ts, components/course-search.tsx): a module, the lines
 * that name it, a lesson and its title as drawn.
 */
export function CourseOutline({
  course,
  base,
  start,
  done,
  current,
  held,
  language = "en",
}: {
  course: Course;
  /** The course page's path, lessons hang under it. */
  base: string;
  /** When this student joined; null for a visitor who has not bought it. */
  start: number | null;
  done: Set<string>;
  current?: string;
  /** Lessons a quiz that must be passed, or work to hand in, still holds shut, for this student: by the lesson holding them. */
  held?: Map<string, string>;
  language?: LanguageCode;
}) {
  const w = coursesWords(language);
  const locale = LANGUAGES[parseLanguage(language)].locale;
  const taskLessons = new Set(course.modules.flatMap((unit) => unit.lessons.filter((lesson) => lesson.task).map((lesson) => lesson.id)));
  return (
    <ol className="space-y-5">
      {course.modules.map((unit, mi) => {
        const open = start !== null && isOpen(course, unit, start);
        return (
          <li key={unit.id} data-find-module="">
            <p className="st-label" data-find-name="">{w.module(mi + 1)}</p>
            <p className="font-semibold" style={{ color: "var(--st-text)" }} data-find-name="">{unit.title}</p>
            {/*
              When this module opens, and said to somebody who has not bought
              it yet as well.

              On a cohort the whole schedule is known before anyone joins,
              because it hangs off one date rather than off each student's
              own. So a visitor reading the outline sees real dates, which is
              the thing worth knowing before paying for a course that runs to
              a timetable — and a module with no wait is still a date there,
              not "at once", because day one of a cohort is a day.
            */}
            {!open && (unit.dripDays > 0 || isCohort(course)) ? (
              <p className="st-muted mt-0.5 text-sm">
                {isCohort(course) ? (
                  <WithDay text={unit.dripDays === 0 ? w.startsOn : w.opensOn} seconds={opensAt(course, unit, 0)} locale={locale} />
                ) : start !== null ? (
                  <WithDay text={w.opensOn} seconds={opensAt(course, unit, start)} locale={locale} />
                ) : (
                  w.opensAfter(unit.dripDays)
                )}
              </p>
            ) : null}
            {unit.lessons.length === 0 ? (
              <p className="st-muted mt-1 text-sm">{w.noLessons}</p>
            ) : (
              <ol className="mt-2 space-y-1">
                {unit.lessons.map((lesson) => {
                  const waiting = open && Boolean(held?.has(lesson.id));
                  // What holds it shut: a quiz to pass, or work to hand in (lib/assignment-rules.ts).
                  const behindTask = waiting && taskLessons.has(held?.get(lesson.id) ?? "");
                  const reachable = (open && !waiting) || lesson.preview;
                  const isDone = done.has(lesson.id);
                  const here = lesson.id === current;
                  const mark = isDone ? "✓" : reachable ? "○" : "🔒";
                  const label = `${lesson.title}${lesson.video ? w.video : ""}`;
                  return (
                    <li key={lesson.id} className="flex items-start gap-2 text-sm" data-find-lesson="">
                      <span aria-hidden="true" className="w-5 shrink-0 text-center">{mark}</span>
                      <span className="min-w-0 flex-1">
                        {reachable ? (
                          <Link
                            href={`${base}/${lesson.id}`}
                            aria-current={here ? "page" : undefined}
                            className={`break-words underline-offset-2 hover:underline ${here ? "font-bold underline" : ""}`}
                            style={{ color: "var(--st-text)" }}
                            data-find-text=""
                          >
                            {label}
                          </Link>
                        ) : (
                          <span className="st-muted break-words" data-find-text="">{label}</span>
                        )}
                        {isDone ? <span className="sr-only">{w.doneHidden}</span> : null}
                        {lesson.quiz ? (
                          <span className="st-muted ml-2 text-xs font-semibold">{lesson.quiz.required ? w.quizToPass : w.quiz}</span>
                        ) : lesson.task ? (
                          <span className="st-muted ml-2 text-xs font-semibold">{w.taskToHandIn}</span>
                        ) : null}
                        {waiting && !lesson.preview ? (
                          <span className="st-muted block text-xs">{behindTask ? w.opensOnTask : w.opensOnPass}</span>
                        ) : null}
                        {!open && lesson.preview ? (
                          <span className="ml-2 text-xs font-bold uppercase tracking-wide" style={{ color: "var(--st-accent-text)" }}>{w.freePreview}</span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </li>
        );
      })}
    </ol>
  );
}
