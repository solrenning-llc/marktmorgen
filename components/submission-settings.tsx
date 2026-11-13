"use client";

import { useEffect, useRef, useState } from "react";
import { useLeaveGuard } from "@/components/leave-guard";
import { toast } from "@/components/toast";
import {
  DEFAULT_SUBMISSION_BYTES,
  DEFAULT_SUBMISSION_KEEP_DAYS,
  MAX_SUBMISSION_BYTES,
  MAX_SUBMISSION_INSTRUCTION,
  SUBMISSION_KINDS,
  type SubmissionKind,
  type SubmissionSetup,
} from "@/lib/submission-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MiB = 1024 * 1024;

/** The largest-file choices, all inside the code's maximum. */
export const SIZE_CHOICES: { bytes: number; label: string }[] = [
  { bytes: 25 * MiB, label: "25 MB" },
  { bytes: 100 * MiB, label: "100 MB" },
  { bytes: 250 * MiB, label: "250 MB" },
  { bytes: 500 * MiB, label: "500 MB" },
  { bytes: MAX_SUBMISSION_BYTES, label: "1 GB" },
];
/** How long files are kept, in days. */
export const KEEP_CHOICES = [30, 90, 180, 365];

export const KIND_WORDS: Record<SubmissionKind, string> = {
  video: "Video (MP4, MOV or WebM)",
  photo: "Photo (JPEG, PNG or WebP)",
  pdf: "PDF",
};

const ERRORS: Record<string, string> = {
  instruction: "Write what the buyer should send, in a few words.",
  kinds: "Choose at least one kind of file.",
  size: "Choose the largest file you take.",
  keep: "Choose how long files are kept.",
  unavailable: "We could not reach your store's data just now. Nothing was changed. Try again in a moment.",
  unknown: "This lesson is no longer in the course. Reload the page.",
  full: "Your store's data room is full. Remove something you no longer need, then try again.",
  signed_out: "Your session ended. Log in again.",
};

/** The setup in one line, for the lesson's panel. */
export function submissionWords(setup: SubmissionSetup): string {
  const size = SIZE_CHOICES.find((choice) => choice.bytes === setup.maxBytes)?.label ?? `${Math.round(setup.maxBytes / MiB)} MB`;
  const kinds = setup.kinds.map((kind) => (kind === "pdf" ? "PDF" : kind)).join(", ");
  return `${kinds} · up to ${size} · kept ${setup.keepDays} days`;
}

type Draft = { instruction: string; kinds: SubmissionKind[]; maxBytes: number; keepDays: number };

/**
 * A lesson's "Ask for a submission" settings in the studio (750 [CD1]): what
 * the buyer is asked to send, which kinds of file, the largest file, and how
 * long files are kept. Stopping asking can be undone from the same place for
 * as long as the page is open, with no time limit; files already sent stay.
 */
export function SubmissionSettings({ productId, lessonId }: { productId: string; lessonId: string }) {
  const [setup, setSetup] = useState<SubmissionSetup | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [opened, setOpened] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<SubmissionSetup | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const main = useRef<HTMLButtonElement>(null);
  // Once the form or the undo line that held focus is gone, focus goes to the panel's main button (WCAG 2.4.3),
  // after the next render, when it is in place.
  const focusMain = useRef(false);
  const setFocusMain = (on: boolean) => {
    focusMain.current = on;
  };
  const prefix = `submission-${lessonId}`;
  useEffect(() => {
    if (!focusMain.current) return;
    focusMain.current = false;
    main.current?.focus();
  });
  useLeaveGuard(draft !== null && JSON.stringify(draft) !== opened && !busy);

  async function read(): Promise<SubmissionSetup | null | undefined> {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/store/course/submissions?id=${encodeURIComponent(productId)}&lessonId=${encodeURIComponent(lessonId)}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; setup?: SubmissionSetup | null };
      if (!data.ok || data.setup === undefined) {
        setError(ERRORS[data.error ?? ""] ?? ERRORS.unavailable);
        return undefined;
      }
      setSetup(data.setup);
      return data.setup;
    } catch {
      setError(ERRORS.unavailable);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    if (busy) return;
    const now = setup === undefined ? await read() : setup;
    if (now === undefined) return;
    const fresh: Draft = now ?? { instruction: "", kinds: ["video"], maxBytes: DEFAULT_SUBMISSION_BYTES, keepDays: DEFAULT_SUBMISSION_KEEP_DAYS };
    setDraft(fresh);
    setOpened(JSON.stringify(fresh));
  }

  async function send(next: SubmissionSetup | null): Promise<{ ok: boolean; was?: SubmissionSetup | null }> {
    if (busy) return { ok: false };
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/course/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setup", id: productId, lessonId, setup: next }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; setup?: SubmissionSetup | null; was?: SubmissionSetup | null };
      if (!data.ok) {
        setError(ERRORS[data.error ?? ""] ?? STUDIO_MESSAGES[data.error ?? ""] ?? ERRORS.unavailable);
        return { ok: false };
      }
      setSetup(data.setup ?? null);
      return { ok: true, was: data.was ?? null };
    } catch {
      setError(ERRORS.unavailable);
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }

  const errorLine = error ? (
    <p className="notice notice-error mt-2" role="alert">
      {error}
    </p>
  ) : null;

  if (!draft) {
    return (
      <div>
        <p className="field-label">Files from buyers</p>
        {setup ? (
          <p className="mt-1 text-sm text-ink">{submissionWords(setup)}</p>
        ) : (
          <p className="mt-1 text-sm text-ink-mute">
            Ask buyers of this course to send you a video, a photo or a PDF for this lesson, and answer each one in writing.
          </p>
        )}
        <button ref={main} type="button" className="btn btn-secondary btn-sm mt-2" aria-disabled={busy} aria-busy={busy} onClick={open}>
          {busy ? "Opening…" : setup === undefined ? "Open these settings" : setup ? "Change what you ask for" : "Ask for a submission"}
        </button>
        {undo ? (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink" role="status" ref={status}>
            You stopped asking for files on this lesson. Files already sent are kept.
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-disabled={busy}
              onClick={async () => {
                const done = await send(undo);
                if (done.ok) {
                  setUndo(null);
                  setFocusMain(true);
                  toast("Asking for files again, as before.");
                }
              }}
            >
              Undo
            </button>
          </p>
        ) : null}
        {errorLine}
      </div>
    );
  }

  const toggle = (kind: SubmissionKind, on: boolean) =>
    setDraft({ ...draft, kinds: on ? SUBMISSION_KINDS.filter((k) => k === kind || draft.kinds.includes(k)) : draft.kinds.filter((k) => k !== kind) });

  return (
    <form
      className="rounded-[var(--r-sm)] border border-line bg-paper p-4"
      aria-labelledby={`${prefix}-title`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!draft.instruction.trim()) return setError(ERRORS.instruction);
        if (!draft.kinds.length) return setError(ERRORS.kinds);
        const done = await send({ instruction: draft.instruction.trim(), kinds: draft.kinds, maxBytes: draft.maxBytes, keepDays: draft.keepDays });
        if (done.ok) {
          toast("Saved. Buyers of this course are asked for a file on this lesson.");
          setDraft(null);
          setFocusMain(true);
        }
      }}
    >
      <h3 id={`${prefix}-title`} className="field-label">
        Ask for a submission
      </h3>
      <label className="mt-3 block">
        <span className="field-label">What the buyer should send</span>
        <textarea
          className="field mt-2"
          rows={4}
          maxLength={MAX_SUBMISSION_INSTRUCTION}
          value={draft.instruction}
          onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
          placeholder="For example: Film one set of squats from the side, so I can see your knees and hips."
          aria-describedby={`${prefix}-hint`}
          required
        />
        <span id={`${prefix}-hint`} className="mt-1 block text-xs text-ink-soft">
          Buyers see this under the lesson, in your words. {draft.instruction.length} of {MAX_SUBMISSION_INSTRUCTION} characters.
        </span>
      </label>
      <fieldset className="mt-3">
        <legend className="field-label">Kinds of file you take</legend>
        {SUBMISSION_KINDS.map((kind) => (
          <label key={kind} className="mt-1 flex min-h-11 cursor-pointer items-center gap-3 text-sm text-ink">
            <input type="checkbox" className="h-4 w-4 shrink-0 accent-violet-brand" checked={draft.kinds.includes(kind)} onChange={(e) => toggle(kind, e.target.checked)} />
            <span>{KIND_WORDS[kind]}</span>
          </label>
        ))}
      </fieldset>
      <label className="mt-3 block">
        <span className="field-label">Largest file</span>
        <select className="field mt-2 min-h-11" value={draft.maxBytes} onChange={(e) => setDraft({ ...draft, maxBytes: Number(e.target.value) })} aria-describedby={`${prefix}-size-hint`}>
          {SIZE_CHOICES.map((choice) => (
            <option key={choice.bytes} value={choice.bytes}>
              {choice.label}
            </option>
          ))}
        </select>
        <span id={`${prefix}-size-hint`} className="mt-1 block text-xs text-ink-soft">
          Each file counts toward your plan&rsquo;s storage. When your storage is full, buyers cannot send more.
        </span>
      </label>
      <label className="mt-3 block">
        <span className="field-label">Keep each file for</span>
        <select className="field mt-2 min-h-11" value={draft.keepDays} onChange={(e) => setDraft({ ...draft, keepDays: Number(e.target.value) })} aria-describedby={`${prefix}-keep-hint`}>
          {KEEP_CHOICES.map((days) => (
            <option key={days} value={days}>
              {days} days
            </option>
          ))}
        </select>
        <span id={`${prefix}-keep-hint`} className="mt-1 block text-xs text-ink-soft">
          After that, the file and your reply are deleted by themselves.
        </span>
      </label>
      {errorLine}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button type="submit" aria-busy={busy} aria-disabled={busy} className="btn btn-primary btn-sm">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setDraft(null); setError(null); setFocusMain(true); }}>
          Cancel
        </button>
        {setup ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto"
            aria-disabled={busy}
            onClick={async () => {
              const done = await send(null);
              if (done.ok) {
                setDraft(null);
                setUndo(done.was ?? setup);
                setFocusMain(true);
              }
            }}
          >
            Stop asking for files
          </button>
        ) : null}
      </div>
    </form>
  );
}
