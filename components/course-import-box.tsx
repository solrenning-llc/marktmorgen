"use client";

import { useRef, useState } from "react";
import type { Course } from "@/lib/course";
import { IMPORT_MAX_BYTES, type ImportChange } from "@/lib/course-import-apply";
import { IMPORT_EXAMPLE, type ImportAnswer, importProblem, placeWords } from "@/lib/course-import-words";

type Preview = { modules: number; lessons: number; toUpload: { at: string; kind: "video" | "file"; path: string }[]; changed: ImportChange[] };
type Uploads = { lesson: string; kind: "video" | "file"; path: string }[];

async function send(payload: Record<string, unknown>): Promise<ImportAnswer & Record<string, unknown>> {
  try {
    const response = await fetch("/api/store/course/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as ImportAnswer & Record<string, unknown>;
  } catch {
    return { error: "server_error" };
  }
}

/**
 * The studio's box for bringing in a course outline the creator already
 * wrote (260 [KJ5], unit 4), on a new course only (`show`, the same
 * condition as the ready structures). The file is read here, in the
 * browser; the import route checks it and answers what it would add, what
 * the editor's own cleaning would keep differently and which videos and
 * files are left to upload. Nothing is saved until "Import", which sends
 * the same file again with `confirm: true`. Afterward the box stays to
 * list the videos and files by lesson, until the page is left.
 */
export function CourseImportBox({
  productId,
  show,
  busy,
  onImported,
}: {
  productId: string;
  /** Whether the course is exactly as it was made (lib/course-templates.ts, templateFits). */
  show: boolean;
  /** The course editor saving something else: nothing is sent meanwhile. */
  busy: boolean;
  onImported: (kept: Course) => void;
}) {
  const [outline, setOutline] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [uploads, setUploads] = useState<Uploads | null>(null);
  const input = useRef<HTMLInputElement>(null);

  if (!show && !uploads) return null;
  const blocked = busy || working;

  function reset() {
    setOutline(null);
    setFileName("");
    setPreview(null);
    setProblem(null);
    if (input.current) input.current.value = "";
    input.current?.focus();
  }

  async function choose(file: File | undefined) {
    setPreview(null);
    setProblem(null);
    setOutline(null);
    if (!file) return;
    setFileName(file.name);
    if (file.size > IMPORT_MAX_BYTES) {
      setProblem(importProblem({ error: "too_large" }));
      return;
    }
    setWorking(true);
    const text = await file.text().catch(() => null);
    if (text === null) {
      setWorking(false);
      setProblem("This file can't be opened. Choose it again. Nothing was imported.");
      return;
    }
    const answer = await send({ id: productId, outline: text });
    setWorking(false);
    if (answer.ok !== true || answer.state !== "preview") {
      setProblem(importProblem(answer));
      return;
    }
    setOutline(text);
    setPreview({ modules: Number(answer.modules), lessons: Number(answer.lessons), toUpload: (answer.toUpload as Preview["toUpload"]) ?? [], changed: (answer.changed as ImportChange[]) ?? [] });
  }

  async function confirm() {
    if (!outline || blocked) return;
    setWorking(true);
    setProblem(null);
    const answer = await send({ id: productId, outline, confirm: true });
    setWorking(false);
    if (answer.ok !== true || !answer.course) {
      setProblem(importProblem(answer));
      return;
    }
    const kept = answer.course as Course;
    const titles = new Map<string, string>();
    kept.modules.forEach((unit) => unit.lessons.forEach((lesson) => titles.set(lesson.id, `${unit.title}: ${lesson.title}`)));
    const left = (answer.toUpload as { lessonId: string; kind: "video" | "file"; path: string }[]) ?? [];
    setUploads(left.map(({ lessonId, kind, path }) => ({ lesson: titles.get(lessonId) ?? "A lesson", kind, path })));
    setPreview(null);
    setOutline(null);
    onImported(kept);
  }

  return (
    <section className="card p-6 sm:p-8" aria-labelledby="course-import-title" data-course-import>
      <h2 id="course-import-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Bring in a course you already wrote
      </h2>

      {uploads ? (
        <div className="mt-2 max-w-2xl" role="status">
          <p className="text-ink">
            Your outline is in the course. {uploads.length
              ? `Upload these ${uploads.length === 1 ? "file" : `${uploads.length} files`} into their lessons below:`
              : "It had no videos or files to upload."}
          </p>
          {uploads.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-6 text-ink">
              {uploads.map((u, i) => (
                <li key={i}>
                  {u.lesson} — {u.kind === "video" ? "video" : "download"} <code className="break-all">{u.path}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <>
          <p className="mt-2 max-w-2xl text-ink-soft">
            Choose an outline file. You will see what it adds before anything is saved. Videos and files are listed for you to upload afterward.
          </p>
          <details className="mt-3 max-w-2xl">
            <summary className="cursor-pointer text-ink underline underline-offset-4">What the outline file looks like</summary>
            <p className="mt-2 text-ink-soft">
              A JSON file like this one. Every field is needed. Quizzes, opening days and other settings are not part of it: you add them in the editor.
            </p>
            <pre tabIndex={0} role="region" aria-label="Example outline file" className="mt-2 overflow-x-auto rounded-xl bg-white p-3 font-mono text-sm text-ink ring-1 ring-line">{IMPORT_EXAMPLE}</pre>
          </details>

          <div className="mt-4">
            <label htmlFor="course-import-file" className="field-label">Outline file (.json)</label>
            <input
              ref={input}
              id="course-import-file"
              type="file"
              accept="application/json,.json"
              className="mt-2 block min-h-11 text-ink"
              disabled={blocked}
              onChange={(event) => void choose(event.target.files?.[0])}
            />
          </div>

          <div aria-live="polite" className="mt-4">
            {working ? <p className="text-ink-soft">Checking {fileName || "the file"}…</p> : null}
            {preview ? (
              <div className="max-w-2xl">
                <p className="text-ink">
                  {fileName} adds {preview.modules} {preview.modules === 1 ? "module" : "modules"} and {preview.lessons} {preview.lessons === 1 ? "lesson" : "lessons"}.
                </p>
                {preview.changed.length ? (
                  <>
                    <p className="mt-2 text-ink">The editor keeps these a little differently (extra spaces and line breaks taken out):</p>
                    <ul className="mt-1 list-disc space-y-1 pl-6 text-ink">
                      {preview.changed.map((c) => <li key={c.path}>{placeWords(c.path)}</li>)}
                    </ul>
                  </>
                ) : null}
                {preview.toUpload.length ? (
                  <p className="mt-2 text-ink">
                    {preview.toUpload.length} {preview.toUpload.length === 1 ? "video or file" : "videos and files"} to upload afterward. They are listed after you import.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          {problem ? <p className="notice notice-error mt-4" role="alert">{problem}</p> : null}

          {preview ? (
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" className="btn btn-primary btn-sm" aria-disabled={blocked || undefined} onClick={() => void confirm()}>
                Import {preview.lessons} {preview.lessons === 1 ? "lesson" : "lessons"}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" aria-disabled={blocked || undefined} onClick={() => { if (!blocked) reset(); }}>
                Choose another file
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
