"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadPresigned } from "@vercel/blob/client";
import { MAX_ANSWER_TEXT, MAX_TASK_FILE_BYTES, type Submission, TASK_ACCEPT, TASK_FILE_TYPES, taskUploadPath } from "@/lib/assignment-rules";
import { coursesWords } from "@/lib/buyer-words/courses";
import type { LanguageCode } from "@/lib/store-language";

const MB = Math.round(MAX_TASK_FILE_BYTES / (1024 * 1024));

/** A fresh id for a file's name: 32 hexadecimal letters, from crypto.getRandomValues, which older phones have too. */
function freshId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A file's kind by its name, as the store keeps it: browsers name some kinds differently, or not at all. */
function kindOf(file: File): string | null {
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const byName = Object.entries(TASK_FILE_TYPES).find(([, ext]) => ext === (extension === "jpeg" ? "jpg" : extension));
  return byName ? byName[0] : null;
}

/**
 * A lesson's assignment, as a student meets it (lib/assignment.ts): what is
 * asked, a box for the answer and a file if the creator takes one, and once
 * handed in, where it stands and what the creator wrote back.
 *
 * Said in the store's `language` (lib/buyer-words/courses.ts).
 */
export function LessonTask({
  prompt,
  setup,
  initial,
  mode,
  where,
  storeName,
  folder = "",
  language = "en",
}: {
  prompt: string;
  setup: { review: boolean; file: boolean };
  initial: Submission | null;
  /** "student" hands it in; "owner" sees it as students do, with where to read their work; "visitor" is told it is there. */
  mode: "student" | "owner" | "visitor";
  where: { handle: string; product: string; lesson: string };
  storeName: string;
  /**
   * The student's own folder for this lesson's files (lib/assignment-rules.ts, taskFolder), given by the lesson page:
   * the file is sent under a fresh name in it, the name the upload door checks and signs.
   */
  folder?: string;
  language?: LanguageCode;
}) {
  const w = coursesWords(language);
  const router = useRouter();
  const [work, setWork] = useState<Submission | null>(initial);
  const [text, setText] = useState(initial?.text ?? "");
  const [file, setFile] = useState<{ path: string; name: string } | null>(initial?.file ? { path: initial.file.path, name: initial.file.name } : null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const closed = Boolean(work && setup.review && work.state === "approved");
  const fileHref = `/api/store/course/task?h=${encodeURIComponent(where.handle)}&p=${where.product}&l=${where.lesson}`;
  const errors: Record<string, string> = {
    needed: w.taskNeeded,
    too_big: w.taskTooBig(MB),
    type: w.taskWrongType,
    full: w.taskFull,
    noroom: w.taskNoRoom,
  };

  async function choose(chosen: File | undefined) {
    if (!chosen) return;
    setError(null);
    setSaid(null);
    const type = kindOf(chosen);
    if (!type) return setError(w.taskWrongType);
    if (chosen.size > MAX_TASK_FILE_BYTES) return setError(w.taskTooBig(MB));
    setUploading(0);
    try {
      // A fresh name in this student's folder: the door signs exactly the name asked for, and the file is sent under it.
      const done = await uploadPresigned(taskUploadPath(folder, TASK_FILE_TYPES[type], freshId()), chosen, {
        access: "private",
        handleUploadUrl: "/api/store/course/task/upload",
        clientPayload: JSON.stringify({ ...where, type }),
        contentType: type,
        onUploadProgress: (progress) => setUploading(progress.percentage),
      });
      setFile({ path: done.pathname, name: chosen.name });
    } catch {
      // @vercel/blob 2.8.0 says only "Failed to retrieve the presigned URL" for any refusal of the door, and takes no
      // payload the page could ask for itself: the reason (no room, too many files this hour, a pause) cannot be read
      // here, so the student is told the likely ones (pre-review of 9 November 2026).
      setError(w.taskFileFailed);
    } finally {
      setUploading(null);
      if (picker.current) picker.current.value = "";
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim() && !file) return setError(w.taskNeeded);
    setSending(true);
    setError(null);
    setSaid(null);
    try {
      const response = await fetch("/api/store/course/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...where, text, file }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; submission?: Submission | null };
      if (!data.ok || !data.submission) {
        setError(errors[data.error ?? ""] ?? w.taskFailed);
        return;
      }
      setWork(data.submission);
      setSaid(data.submission.state === "waiting" ? w.taskWaiting(storeName) : w.taskDone);
      // The lesson may be done now, and the lessons after it open.
      router.refresh();
    } catch {
      setError(w.taskFailed);
    } finally {
      setSending(false);
    }
  }

  const heading = <h2 id="task-title" className="font-display text-xl font-semibold">{w.task}</h2>;
  const asked = <p className="mt-3 whitespace-pre-wrap break-words" style={{ color: "var(--st-text)" }}>{prompt}</p>;

  if (mode !== "student") {
    return (
      <section id="task" className="mt-8 scroll-mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }} aria-labelledby="task-title">
        {heading}
        {asked}
        <p className="st-muted mt-3 text-sm">{mode === "owner" ? w.taskOwner : w.taskVisitor}</p>
      </section>
    );
  }

  const state =
    work?.state === "waiting" ? w.taskWaiting(storeName) : work?.state === "again" ? w.taskAgain(storeName) : work ? (setup.review ? w.taskApproved : w.taskDone) : null;

  return (
    <section id="task" className="mt-8 scroll-mt-6 rounded-2xl px-5 py-5" style={{ border: "1px solid var(--st-line)" }} aria-labelledby="task-title">
      {heading}
      {asked}

      {state && !said ? (
        <p className="st-note mt-4 text-sm" role="status">{state}</p>
      ) : null}
      {said ? (
        <p className="st-note mt-4 text-sm" role="status">{said}</p>
      ) : null}

      {work?.feedback ? (
        <div className="mt-4 rounded-xl px-4 py-3" style={{ background: "var(--st-item)", border: "1px solid var(--st-line)" }}>
          <p className="st-label">{w.taskFeedback(storeName)}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm" style={{ color: "var(--st-text)" }}>{work.feedback}</p>
        </div>
      ) : null}

      {closed && work ? (
        <div className="mt-4">
          <p className="st-label">{w.taskYouHanded}</p>
          {work.text ? <p className="mt-1 whitespace-pre-wrap break-words text-sm" style={{ color: "var(--st-text)" }}>{work.text}</p> : null}
          {work.file ? (
            <a href={fileHref} className="mt-2 inline-block break-all text-sm font-semibold underline underline-offset-2" style={{ color: "var(--st-text)" }}>
              {work.file.name}
            </a>
          ) : null}
        </div>
      ) : (
        <form className="mt-4" onSubmit={send} aria-describedby="task-title">
          <label className="block">
            <span className="st-label">{w.taskAnswer}</span>
            <textarea
              className="st-field mt-2"
              rows={6}
              maxLength={MAX_ANSWER_TEXT}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {setup.file ? (
            <div className="mt-4">
              {file ? (
                <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                  <span className="st-muted">{w.taskYourFile}</span>
                  {work?.file?.path === file.path ? (
                    <a href={fileHref} className="min-w-0 break-all font-semibold underline underline-offset-2" style={{ color: "var(--st-text)" }}>{file.name}</a>
                  ) : (
                    <span className="min-w-0 break-all font-semibold" style={{ color: "var(--st-text)" }}>{file.name}</span>
                  )}
                  <button type="button" className="st-footer-link font-semibold" onClick={() => setFile(null)} disabled={sending}>{w.taskRemoveFile}</button>
                </p>
              ) : (
                <label className="block">
                  <span className="st-label">{w.taskFile}</span>
                  <input
                    ref={picker}
                    type="file"
                    accept={TASK_ACCEPT}
                    className="mt-2 block w-full text-sm"
                    disabled={uploading !== null || sending}
                    onChange={(e) => choose(e.target.files?.[0])}
                    aria-describedby="task-file-hint"
                  />
                  <span id="task-file-hint" className="st-muted mt-1 block text-xs">{w.taskFileHint(MB)}</span>
                </label>
              )}
              {uploading !== null ? (
                <p className="st-muted mt-2 text-sm" role="status">{`${w.taskSending} ${Math.round(uploading)}%`}</p>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p className="st-note mt-4 text-sm" role="alert">{error}</p>
          ) : null}
          <button type="submit" className="btn st-btn mt-4" disabled={sending || uploading !== null} aria-busy={sending}>
            {sending ? w.taskSending : work ? w.taskHandInAgain : w.taskHandIn}
          </button>
        </form>
      )}
    </section>
  );
}
