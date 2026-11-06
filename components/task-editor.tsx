"use client";

import { useState } from "react";
import { useLeaveGuard } from "@/components/leave-guard";
import { toast } from "@/components/toast";
import type { Course } from "@/lib/course";
import { MAX_TASK_PROMPT, type Task, type TaskSetup } from "@/lib/assignment-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

type Draft = { prompt: string; review: boolean; gate: boolean; file: boolean };

const small = "text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:no-underline disabled:opacity-40";

const ERRORS: Record<string, string> = {
  prompt: "Write what the student should do or hand in.",
  quiz_there: "This lesson has a quiz. A lesson is finished by its quiz or by an assignment, not both: remove the quiz first.",
  signed_out: "Your session ended. Log in again.",
  busy: "Another change to this course is being saved. Try again in a moment.",
};

/** The switches, as one line: what the outline and the studio show. */
export function taskWords(setup: TaskSetup): string {
  return [
    setup.review ? "you read and approve each one" : "done when handed in",
    setup.gate ? "must be finished to go on" : "optional",
    setup.file ? "a file may be added" : "text only",
  ].join(" · ");
}

/**
 * A lesson's assignment in the studio (lib/assignment.ts): what the student
 * is asked to do, and three switches — whether the creator reads and
 * approves each one, whether the lessons after it wait for it, and whether a
 * file may be handed in.
 */
export function TaskEditor({
  productId,
  lessonId,
  setup,
  hasQuiz,
  onCourse,
}: {
  productId: string;
  lessonId: string;
  setup: TaskSetup | null;
  hasQuiz: boolean;
  onCourse: (course: Course) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  // The assignment as it was opened: leaving with changes to it asks first (487 [IT4], item 6), an untouched one never.
  const [opened, setOpened] = useState("");
  useLeaveGuard(draft !== null && JSON.stringify(draft) !== opened && !busy);

  async function open() {
    setError(null);
    if (!setup) {
      const fresh = { prompt: "", review: true, gate: false, file: true };
      setDraft(fresh);
      setOpened(JSON.stringify(fresh));
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/store/course?id=${productId}&lessonId=${lessonId}&task=1`, { cache: "no-store" });
      const data = (await response.json()) as { ok?: boolean; task?: Task | null };
      if (!data.ok || !data.task) {
        setError("The assignment could not be read just now. Try again in a moment.");
        return;
      }
      const read = { prompt: data.task.prompt, review: data.task.review, gate: data.task.gate, file: data.task.file };
      setDraft(read);
      setOpened(JSON.stringify(read));
    } catch {
      setError("The assignment could not be read just now. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  async function send(task: Draft | null): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/course", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "task", id: productId, lessonId, task }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; course?: Course };
      if (data.ok && data.course) {
        onCourse(data.course);
        return true;
      }
      setError(ERRORS[data.error ?? ""] ?? STUDIO_MESSAGES[data.error ?? ""] ?? "Something went wrong on our side. Nothing was saved; try again in a moment.");
      return false;
    } catch {
      setError("Something went wrong on our side. Nothing was saved; try again in a moment.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!draft) {
    return (
      <div>
        <p className="field-label">Assignment</p>
        {setup ? (
          <p className="mt-1 text-sm text-ink">{taskWords(setup)}</p>
        ) : hasQuiz ? (
          <p className="mt-1 text-sm text-ink-mute">This lesson is finished by its quiz. A lesson can have an assignment instead of a quiz.</p>
        ) : (
          <p className="mt-1 text-sm text-ink-mute">
            Ask students to do something and hand it in: a few paragraphs, a file, or both. You read it, write back, and approve it
            or ask for another try.
          </p>
        )}
        {hasQuiz && !setup ? null : (
          <button type="button" className="btn btn-secondary btn-sm mt-2" disabled={loading} aria-busy={loading} onClick={open}>
            {loading ? "Opening…" : setup ? "Edit the assignment" : "Add an assignment"}
          </button>
        )}
        {error ? (
          <p className="notice notice-error mt-2" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const prefix = `task-${lessonId}`;
  return (
    <form
      className="rounded-[var(--r-sm)] border border-line bg-paper p-4"
      aria-label="Assignment"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!draft.prompt.trim()) {
          setError(ERRORS.prompt);
          return;
        }
        if (await send(draft)) {
          toast("Assignment saved.");
          setDraft(null);
        }
      }}
    >
      <p className="field-label">Assignment</p>
      <label className="mt-3 block">
        <span className="field-label">What the student does</span>
        <textarea
          className="field mt-2"
          rows={5}
          maxLength={MAX_TASK_PROMPT}
          value={draft.prompt}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          placeholder="For example: Write the opening paragraph of your own sales page, using the three questions from this lesson. Add a screenshot if you built it already."
          aria-describedby={`${prefix}-hint`}
          required
        />
        <span id={`${prefix}-hint`} className="mt-1 block text-xs text-ink-soft">
          Students see this under the lesson, in your words, with a box for their answer.
        </span>
      </label>
      <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 text-sm text-ink">
        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" checked={draft.review} onChange={(e) => setDraft({ ...draft, review: e.target.checked })} />
        <span>
          <span className="font-semibold">I read and approve each one.</span> Handed-in work waits for you on this page and you get an
          email, once an hour at most. What you write back reaches the student by email. Without this, handing it in finishes the lesson.
        </span>
      </label>
      <label className="mt-1 flex min-h-11 cursor-pointer items-start gap-3 text-sm text-ink">
        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" checked={draft.gate} onChange={(e) => setDraft({ ...draft, gate: e.target.checked })} />
        <span>
          <span className="font-semibold">Students must finish it to go on.</span>{" "}
          {draft.review
            ? "The lessons after this one stay locked until you approve their work."
            : "The lessons after this one stay locked until they hand it in."}
        </span>
      </label>
      <label className="mt-1 flex min-h-11 cursor-pointer items-start gap-3 text-sm text-ink">
        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" checked={draft.file} onChange={(e) => setDraft({ ...draft, file: e.target.checked })} />
        <span>
          <span className="font-semibold">Students may add a file.</span> A PDF, a Word, PowerPoint or Excel file, text, a picture or audio, up
          to 10 MB, kept with your store&rsquo;s files.
        </span>
      </label>

      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary btn-sm">
          {busy ? "Saving…" : "Save the assignment"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setDraft(null); setError(null); setRemoving(false); }}>
          Cancel
        </button>
        {setup ? (
          removing ? (
            <span className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-soft">Remove the assignment? The work students handed in for it is deleted too.</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={async () => {
                  if (await send(null)) {
                    toast("Assignment removed.");
                    setDraft(null);
                    setRemoving(false);
                  }
                }}
              >
                Yes, remove it
              </button>
              <button type="button" className={`${small} font-bold`} onClick={() => setRemoving(false)}>Keep it</button>
            </span>
          ) : (
            <button type="button" className="ml-auto text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger" onClick={() => setRemoving(true)}>
              Remove the assignment
            </button>
          )
        ) : null}
      </div>
    </form>
  );
}
