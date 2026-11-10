"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "@/components/toast";
import type { NextActionId } from "@/lib/next-actions-rules";

/**
 * "Write a draft with AI" under one "Do this next" action (484 [IT1] complement WG, unit 3): only when pressed, the
 * writing help drafts the email (app/api/store/next-actions/draft) and it comes back into two fields the creator can
 * change, with a button to copy it. Nothing is saved and nothing is sent from here, and the screen says so. Focus
 * goes to the subject once the draft is there, and back to the button if it is closed (2.4.3); the outcome is said
 * in a polite live region; a button in use is aria-disabled, never disabled, so focus stays on it.
 */
const SAID: Record<string, string> = {
  off: "The writing help is not available for your store right now. Nothing was counted.",
  used: "Your store has used this month's AI uses. They start again with your next month.",
  failed: "The draft could not be written just now. It used one of this month's AI uses. Try again in a moment.",
  notes: "This draft could not be prepared. Nothing was counted.",
  unknown: "The numbers behind this could not be read just now, so no draft was written. Reload the page in a moment.",
  gone: "This no longer needs you: the numbers changed since the page opened. Reload the page.",
  slow: "Too many drafts at once. Wait a minute, then try again.",
  forbidden: "Your role on this store cannot write this draft.",
  action: "This action has no draft.",
};

export function NextActionDraft({ action, jobs }: { action: NextActionId; jobs: number }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [live, setLive] = useState("");
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const subject = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<"subject" | "opener" | null>(null);

  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === "subject") subject.current?.focus();
    if (next === "opener") opener.current?.focus();
  }, [draft]);

  async function write() {
    if (busy) return;
    setBusy(true);
    setError("");
    setLive("Writing the draft…");
    try {
      const response = await fetch("/api/store/next-actions/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; value?: { subject?: unknown; body?: unknown } };
      const value = answer.value;
      if (answer.ok === true && value && typeof value.subject === "string" && typeof value.body === "string") {
        focusNext.current = "subject";
        setDraft({ subject: value.subject, body: value.body });
        setLive("The draft is ready below. Nothing was sent.");
      } else {
        setLive("");
        setError(SAID[answer.error ?? ""] ?? SAID.failed);
      }
    } catch {
      setLive("");
      setError("The draft could not be asked for. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(`${draft.subject}\n\n${draft.body}`);
      toast("Draft copied.");
    } catch {
      setError("The draft could not be copied. Select the text and copy it yourself.");
    }
  }

  return (
    <div className="mt-3">
      {draft ? null : (
        <>
          <button ref={opener} type="button" className="btn btn-ghost btn-sm" aria-disabled={busy} aria-describedby={`${id}-cost`} onClick={() => void write()}>
            {busy ? "Writing the draft…" : "Write a draft with AI"}
          </button>
          <p id={`${id}-cost`} className="mt-1 text-xs text-ink-soft">
            {`Uses ${jobs === 1 ? "one" : jobs.toLocaleString("en-US")} of your store's AI uses this month. Nothing is sent: you read it, change it and send it yourself.`}
          </p>
        </>
      )}
      {draft ? (
        <div className="mt-2 space-y-3">
          <p className="text-sm font-semibold text-ink">A draft for you to change. Nothing was sent or saved.</p>
          <div>
            <label htmlFor={`${id}-subject`} className="field-label">Subject</label>
            <input ref={subject} id={`${id}-subject`} className="field mt-1" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </div>
          <div>
            <label htmlFor={`${id}-body`} className="field-label">Email</label>
            <textarea id={`${id}-body`} className="field mt-1" rows={8} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </div>
          <p className="text-sm text-ink-soft">Send it to each member yourself, from your own email. Check the words first: they were written by AI.</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy()}>
              Copy the draft
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                focusNext.current = "opener";
                setDraft(null);
              }}
            >
              Close the draft
            </button>
          </div>
        </div>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">{live}</p>
      {error ? <p className="notice notice-error mt-2" role="alert">{error}</p> : null}
    </div>
  );
}
