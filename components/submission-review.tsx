"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/toast";
import { MAX_SUBMISSION_REPLY, type SubmissionReply, type SubmissionState, type SubmittedFile } from "@/lib/submission-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

/** One kept file as the studio route answers it. */
export type ReviewItem =
  | { id: string; lessonId: string; lessonTitle: string; unread: true }
  | {
      id: string;
      lessonId: string;
      lessonTitle: string;
      buyer: string;
      file: SubmittedFile;
      note: string;
      at: number;
      keepUntil: number;
      state: SubmissionState;
      reply: (SubmissionReply & { at: number }) | null;
      unread?: undefined;
    };

const ERRORS: Record<string, string> = {
  reply: "Write your reply before sending it.",
  reviewed: "This file was already answered. Reload the list to see the reply.",
  gone: "This file is no longer kept: its keeping time ended or its buyer was deleted. Reload the list.",
  expired: "This file's keeping time has ended, so it can no longer be answered.",
  too_long: "Your reply is too long to keep with this file. Shorten it and try again.",
  full: "Your store's data room is full. Remove something you no longer need, then try again.",
  limit: "Your plan's studio requests for this month are used up. Nothing was sent.",
  unavailable: "We could not reach your store's data just now. Nothing was sent. Try again in a moment.",
  signed_out: "Your session ended. Log in again.",
};

export function day(seconds: number): string {
  return seconds ? new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
}
export function size(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/** One kept file: what the buyer sent, and the reply, written and then checked before it is sent. */
export function ReviewEntry({ productId, item }: { productId: string; item: Extract<ReviewItem, { unread?: undefined }> }) {
  const [state, setState] = useState(item.state);
  const [reply, setReply] = useState(item.reply);
  const [text, setText] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useRef<HTMLDivElement>(null);
  const textBox = useRef<HTMLTextAreaElement>(null);
  const kept = useRef<HTMLDivElement>(null);
  // Where focus goes once the control that held it is gone (WCAG 2.4.3): moved after the next render, when the
  // new elements are in place.
  const focusTo = useRef<"confirm" | "text" | "reply" | null>(null);
  const setFocusTo = (to: "confirm" | "text" | "reply") => {
    focusTo.current = to;
  };
  const prefix = `review-${item.id}`;
  useEffect(() => {
    const to = focusTo.current;
    if (!to) return;
    focusTo.current = null;
    ({ confirm, text: textBox, reply: kept })[to].current?.focus();
  });

  async function send() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/course/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reply", id: productId, submission: item.id, text }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; state?: SubmissionState; reply?: SubmissionReply & { at: number } };
      if (!data.ok || !data.reply) {
        setError(ERRORS[data.error ?? ""] ?? STUDIO_MESSAGES[data.error ?? ""] ?? ERRORS.unavailable);
        setChecking(false);
        setFocusTo("text");
        return;
      }
      setState(data.state ?? "reviewed");
      setReply(data.reply);
      setChecking(false);
      setFocusTo("reply");
      toast("Reply saved with the file.");
    } catch {
      setError(ERRORS.unavailable);
      setChecking(false);
      setFocusTo("text");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-[var(--r-sm)] border border-line bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="min-w-0 break-words text-base font-semibold text-ink">{item.lessonTitle}</h3>
        <span className={`tag ${state === "submitted" ? "tag-next" : "tag-live"}`}>{state === "submitted" ? "Waiting for your reply" : state === "reviewed" ? "Answered" : "Withdrawn"}</span>
      </div>
      <p className="mt-1 break-all text-sm text-ink-soft">{`${item.buyer} · sent ${day(item.at)} · kept until ${day(item.keepUntil)}`}</p>
      <p className="mt-2 break-all text-sm text-ink">{`${item.file.name} (${item.file.type}, ${size(item.file.bytes)})`}</p>
      {item.note ? (
        <div className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--r-sm)] bg-sand p-3 text-sm text-ink" tabIndex={0} aria-label="The buyer's note">
          {item.note}
        </div>
      ) : null}
      {reply ? (
        <div ref={kept} tabIndex={-1} className="mt-3 border-t border-line pt-3">
          <p className="field-label">{`Your reply, ${day(reply.at)}`}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{reply.text}</p>
        </div>
      ) : state === "submitted" ? (
        <form
          className="mt-3 border-t border-line pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return setError(ERRORS.reply);
            setError(null);
            setChecking(true);
            // The check is moved to, so a keyboard or screen reader user lands on what to confirm.
            setFocusTo("confirm");
          }}
        >
          <label className="block">
            <span className="field-label">Your reply</span>
            <textarea
              ref={textBox}
              className="field mt-2"
              rows={4}
              maxLength={MAX_SUBMISSION_REPLY}
              value={text}
              readOnly={checking}
              onChange={(e) => setText(e.target.value)}
              aria-describedby={`${prefix}-hint`}
              required
            />
            <span id={`${prefix}-hint`} className="mt-1 block text-xs text-ink-soft">
              {`The buyer reads it with their file. ${text.length} of ${MAX_SUBMISSION_REPLY} characters.`}
            </span>
          </label>
          {checking ? (
            <div ref={confirm} tabIndex={-1} className="notice mt-3" role="group" aria-labelledby={`${prefix}-check`}>
              <p id={`${prefix}-check`} className="text-sm text-ink">
                Send this reply? It cannot be changed once it is sent.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {/* Kept focusable while it sends (aria-disabled), so focus never leaves the check. */}
                <button type="button" className="btn btn-primary btn-sm" aria-disabled={busy} aria-busy={busy} onClick={send}>
                  {busy ? "Sending…" : "Send the reply"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-disabled={busy}
                  onClick={() => {
                    if (busy) return;
                    setChecking(false);
                    setFocusTo("text");
                  }}
                >
                  Change it
                </button>
              </div>
            </div>
          ) : (
            <button type="submit" className="btn btn-secondary btn-sm mt-3">
              Check the reply
            </button>
          )}
          {error ? (
            <p className="notice notice-error mt-2" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

/**
 * The studio's "To review" list for one course (750 [CD1]): files buyers
 * sent, newest first, a page at a time, each answered in writing once. It is
 * read when the creator asks for it, not on every visit to the page, because
 * each page is counted in the plan's studio requests.
 */
export function SubmissionReview({ productId }: { productId: string }) {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(before?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const after = before === undefined ? "" : `&before=${encodeURIComponent(before)}`;
      const response = await fetch(`/api/store/course/submissions?id=${encodeURIComponent(productId)}&list=1${after}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; rows?: ReviewItem[]; next?: string | null };
      if (!data.ok || !Array.isArray(data.rows)) {
        setError(ERRORS[data.error ?? ""] ?? STUDIO_MESSAGES[data.error ?? ""] ?? ERRORS.unavailable);
        return;
      }
      setItems(before === undefined ? data.rows : [...(items ?? []), ...data.rows]);
      setNext(typeof data.next === "string" ? data.next : null);
    } catch {
      setError(ERRORS.unavailable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="submissions-title" id="submissions">
      <h2 id="submissions-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Files from buyers
      </h2>
      <p className="mt-1 text-sm text-ink-soft">Files buyers sent you for review on this course&rsquo;s lessons, newest first.</p>
      {items === null ? (
        <button type="button" className="btn btn-secondary btn-sm mt-3" aria-disabled={busy} aria-busy={busy} onClick={() => load()}>
          {busy ? "Opening…" : "Show files to review"}
        </button>
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-ink" role="status">
          No buyer has sent a file yet.
        </p>
      ) : (
        <>
          <ul className="mt-4 grid gap-3" aria-label="Files to review">
            {items.map((item) =>
              item.unread ? (
                <li key={item.id} className="rounded-[var(--r-sm)] border border-line bg-white p-4 text-sm text-ink">
                  <h3 className="text-base font-semibold text-ink">{item.lessonTitle}</h3>
                  <p className="mt-1">A file is kept for this lesson, but its record could not be read just now. Reload the list to try again.</p>
                </li>
              ) : (
                <ReviewEntry key={item.id} productId={productId} item={item} />
              ),
            )}
          </ul>
          {next !== null ? (
            <button type="button" className="btn btn-secondary btn-sm mt-3" aria-disabled={busy} aria-busy={busy} onClick={() => load(next)}>
              {busy ? "Opening…" : "Show older files"}
            </button>
          ) : null}
        </>
      )}
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
