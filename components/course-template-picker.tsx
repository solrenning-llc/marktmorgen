"use client";

import { useMemo, useState } from "react";
import type { Course } from "@/lib/course";
import { COURSE_TEMPLATES, applyTemplate, draftWords, opensWords, type CourseTemplate } from "@/lib/course-templates";

/**
 * The ready course structures, offered on a new course (540 [CU1], unit 2).
 * A pick is drawn as a draft, here in the browser, with the same
 * applyTemplate the server uses; nothing is saved until "Use this
 * structure", which sends only the structure's id. The editor shows this
 * only while templateFits says the course is exactly as it was made.
 */
export function CourseTemplatePicker({
  course,
  busy,
  save,
  onSkip,
  onApplied,
}: {
  course: Course;
  busy: boolean;
  /** The course editor's own save, which shows the course kept and any error. */
  save: (payload: Record<string, unknown>) => Promise<{ ok?: boolean; course?: Course }>;
  onSkip: () => void;
  onApplied: (kept: Course) => void;
}) {
  const [chosen, setChosen] = useState<CourseTemplate | null>(null);
  // Made once per pick, so the draft's ids (and the list keys) stay the same while the page draws again.
  const draft = useMemo(() => {
    if (!chosen?.modules.length) return null;
    const applied = applyTemplate(course, chosen);
    return applied.ok ? applied.course : null;
  }, [course, chosen]);
  const scratch = chosen?.id === "scratch";

  return (
    <section className="card p-6 sm:p-8" aria-labelledby="course-templates-title" data-course-templates>
      <h2 id="course-templates-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Start from a ready structure
      </h2>
      <p className="mt-2 max-w-2xl text-ink-soft">
        Pick one to see what it adds. Nothing is saved until you say so, and you can change every title and day afterward.
      </p>

      <fieldset className="mt-4 min-w-0">
        <legend className="field-label">Pick a structure</legend>
        <div className="mt-2 grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
          {COURSE_TEMPLATES.map((template) => (
            <label
              key={template.id}
              className={`flex min-h-11 cursor-pointer gap-3 rounded-2xl p-4 ${chosen?.id === template.id ? "bg-lilac ring-2 ring-violet-brand" : "bg-paper ring-1 ring-line"}`}
            >
              <input
                type="radio"
                name="course-template"
                value={template.id}
                checked={chosen?.id === template.id}
                onChange={() => setChosen(template)}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <span className="min-w-0">
                <span className="block font-semibold text-ink">{template.name}</span>
                <span className="mt-0.5 block text-sm text-ink-soft">{template.about}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* Said when a structure is picked, so a screen reader hears what it adds before anything is saved. */}
      <p role="status" className="mt-4 text-sm font-semibold text-ink">
        {chosen ? draftWords(chosen) : ""}
      </p>

      {draft && chosen ? (
        <div className="mt-3 rounded-2xl bg-paper p-4 ring-1 ring-line" data-course-template-draft>
          <h3 className="text-base font-semibold text-ink">{`What "${chosen.name}" adds`}</h3>
          <ol className="mt-2 space-y-3 text-sm">
            {draft.modules.map((unit, i) => (
              <li key={unit.id}>
                <p className="font-semibold text-ink">{`${i + 1}. ${unit.title}`}</p>
                <p className="text-ink-mute">{opensWords(unit.dripDays)}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-6 text-ink-soft">
                  {unit.lessons.map((lesson) => (
                    <li key={lesson.id}>{lesson.title}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          {draft.certificate ? (
            <p className="mt-3 text-sm text-ink-soft">
              The certificate of completion will be switched on. You can switch it off under &ldquo;Certificate of completion&rdquo;, further down this page.
            </p>
          ) : null}
          <p className="mt-3 text-sm text-ink-soft">
            Each lesson is added with its title only: its video, text and files are yours to add.
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        {draft && chosen ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            aria-busy={busy}
            onClick={async () => {
              if (busy) return;
              const answer = await save({ action: "template", template: chosen.id });
              if (answer.ok && answer.course) onApplied(answer.course);
            }}
          >
            Use this structure
          </button>
        ) : null}
        {/* "Start from scratch" picked: its own button does what it says; otherwise the way out of the structures is "Keep an empty course". */}
        <button type="button" className={`btn btn-sm ${scratch ? "btn-primary" : "btn-ghost"}`} disabled={busy} onClick={onSkip}>
          {scratch ? "Start from scratch" : "Keep an empty course"}
        </button>
      </div>
    </section>
  );
}
