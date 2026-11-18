"use client";

import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { AiDraftReview } from "@/components/ai-draft-review";
import { toast } from "@/components/toast";
import { firstUnchecked, freshChecks, reviewDone } from "@/lib/ai-draft-review";
import type { NextActionId } from "@/lib/next-actions-rules";

/**
 * "Write a draft with AI" under one "Do this next" action (484 [IT1] complement WG, unit 3): only when pressed, the
 * writing help drafts the email (app/api/store/next-actions/draft) and it comes back into two fields the creator can
 * change, with a button to copy it. Nothing is saved and nothing is sent from here, and the screen says so. The draft
 * is shown under the "AI draft" badge and the three checks every draft the writing help fills in gets
 * (lib/ai-draft-review.ts, 756 [STN3]); "Copy the draft" waits until all three are checked, because a copied draft
 * leaves the studio and its save hold. Focus goes to the subject once the draft is there, and back to the button if
 * it is closed (2.4.3); the outcome is said in a polite live region; a button in use or waiting is aria-disabled,
 * never disabled, so focus stays on it. The screen never says more than the server knows about the month's uses.
 */
export const NEXT_DRAFT_SAID: Record<string, string> = {
  // "off" also follows a month's use whose reservation could not be confirmed (lib/ai.ts, counted): say nothing about it.
  off: "The writing help is not available for your store right now, so no draft was written.",
  used: "Your store has used this month's AI uses. They start again with your next month.",
  // A try that reached the provider stays counted; one that did not is given back (lib/ai.ts, counted).
  failed: "The draft could not be written just now. A try that reached the AI stays counted in this month's AI uses; one that did not is given back. Try again in a moment.",
  notes: "This draft could not be prepared. Nothing was counted.",
  unknown: "The numbers behind this could not be read just now, so no draft was written. Reload the page in a moment.",
  gone: "This no longer needs you: the numbers changed since the page opened. Reload the page.",
  slow: "Too many drafts at once. Wait a minute, then try again.",
  forbidden: "Your role on this store cannot write this draft.",
  action: "This action has no draft.",
};

/** Why "Copy the draft" waits. */
export const NEXT_DRAFT_COPY_HOLD = "Check the three boxes under the draft, then copy it.";

/** Why Copy refuses now, or null when it may copy: the one decision copy() acts on (LOW on #3558). */
export function copyHold(checks: readonly boolean[]): string | null {
  return reviewDone(checks) ? null : NEXT_DRAFT_COPY_HOLD;
}

type Draft = { subject: string; body: string };

/**
 * The block before a draft, or after one was closed. A closed draft is kept on this page with its edits, so "Show the
 * draft again" brings it back with no new call and no AI use (LOW on #3558; VR 4, 3.3.6): the boxes start unchecked.
 */
export function NextActionDraftClosed({
  id,
  jobs,
  busy,
  kept,
  openerRef,
  onWrite,
  onShowAgain,
}: {
  id: string;
  jobs: number;
  busy: boolean;
  kept: boolean;
  openerRef?: RefObject<HTMLButtonElement | null>;
  onWrite: () => void;
  onShowAgain: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap gap-3">
        {kept ? (
          <button type="button" className="btn btn-secondary btn-sm" aria-describedby={`${id}-again`} onClick={onShowAgain}>
            Show the draft again
          </button>
        ) : null}
        <button ref={openerRef} type="button" className="btn btn-ghost btn-sm" aria-disabled={busy} aria-describedby={`${id}-cost`} onClick={onWrite}>
          {busy ? "Writing the draft…" : kept ? "Write a new draft with AI" : "Write a draft with AI"}
        </button>
      </div>
      {kept ? (
        <p id={`${id}-again`} className="mt-1 text-xs text-ink-soft">
          Shows the draft you closed, with your changes. It uses none of your AI uses.
        </p>
      ) : null}
      <p id={`${id}-cost`} className="mt-1 text-xs text-ink-soft">
        {`${kept ? "A new draft uses" : "Uses"} ${jobs === 1 ? "one" : jobs.toLocaleString("en-US")} of your store's AI uses this month. Nothing is sent: you read it, change it and send it yourself.`}
      </p>
    </>
  );
}

/** The draft as shown: its two fields, the AI draft badge and checks, and Copy waiting until they are checked. */
export function NextActionDraftReady({
  id,
  draft,
  checks,
  subjectRef,
  onEdit,
  onToggle,
  onCopy,
  onClose,
}: {
  id: string;
  draft: Draft;
  checks: readonly boolean[];
  subjectRef: RefObject<HTMLInputElement | null>;
  onEdit: (draft: Draft) => void;
  onToggle: (index: number, ticked: boolean) => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const checked = reviewDone(checks);
  return (
    <div className="mt-2 space-y-3">
      <p className="text-sm font-semibold text-ink">A draft for you to change. Nothing was sent or saved.</p>
      <div>
        <label htmlFor={`${id}-subject`} className="field-label">Subject</label>
        <input ref={subjectRef} id={`${id}-subject`} className="field mt-1" value={draft.subject} onChange={(e) => onEdit({ ...draft, subject: e.target.value })} />
      </div>
      <div>
        <label htmlFor={`${id}-body`} className="field-label">Email</label>
        <textarea id={`${id}-body`} className="field mt-1" rows={8} value={draft.body} onChange={(e) => onEdit({ ...draft, body: e.target.value })} />
      </div>
      <AiDraftReview checks={checks} onToggle={onToggle} act="copy" />
      <p className="text-sm text-ink-soft">Send it to each member yourself, from your own email. Check the words first: they were written by AI.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-secondary btn-sm" aria-disabled={!checked} aria-describedby={checked ? undefined : `${id}-hold`} onClick={onCopy}>
          Copy the draft
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Close the draft
        </button>
      </div>
      {checked ? null : (
        <p id={`${id}-hold`} className="text-sm text-ink-soft">
          {NEXT_DRAFT_COPY_HOLD}
        </p>
      )}
    </div>
  );
}

export function NextActionDraft({ action, jobs }: { action: NextActionId; jobs: number }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [live, setLive] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [kept, setKept] = useState<Draft | null>(null);
  const [checks, setChecks] = useState<boolean[]>(freshChecks);
  const box = useRef<HTMLDivElement>(null);
  const subject = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<"subject" | "opener" | null>(null);

  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === "subject") subject.current?.focus();
    if (next === "opener") opener.current?.focus();
  }, [draft]);

  // A cost that is not a whole number of uses is not known: the server refuses it ("notes"), so no button is offered.
  if (!Number.isSafeInteger(jobs) || jobs <= 0) return null;

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
        setChecks(freshChecks());
        setDraft({ subject: value.subject, body: value.body });
        setLive("The draft is ready below. Nothing was sent.");
      } else {
        setLive("");
        setError(NEXT_DRAFT_SAID[answer.error ?? ""] ?? NEXT_DRAFT_SAID.failed);
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
    const hold = copyHold(checks);
    if (hold) {
      setError(hold);
      const left = firstUnchecked(checks);
      box.current?.querySelectorAll<HTMLInputElement>("[data-ai-review] input[type=checkbox]")[left]?.focus();
      return;
    }
    setError("");
    try {
      await navigator.clipboard.writeText(`${draft.subject}\n\n${draft.body}`);
      toast("Draft copied.");
    } catch {
      setError("The draft could not be copied. Select the text and copy it yourself.");
    }
  }

  return (
    <div ref={box} className="mt-3">
      {draft ? null : (
        <NextActionDraftClosed
          id={id}
          jobs={jobs}
          busy={busy}
          kept={kept !== null}
          openerRef={opener}
          onWrite={() => void write()}
          onShowAgain={() => {
            if (!kept) return;
            focusNext.current = "subject";
            setChecks(freshChecks());
            setDraft(kept);
            setLive("The draft you closed is back below. Nothing was sent.");
          }}
        />
      )}
      {draft ? (
        <NextActionDraftReady
          id={id}
          draft={draft}
          checks={checks}
          subjectRef={subject}
          onEdit={setDraft}
          onToggle={(index, ticked) => {
            setChecks((was) => was.map((value, at) => (at === index ? ticked : value)));
            if (error === NEXT_DRAFT_COPY_HOLD) setError("");
          }}
          onCopy={() => void copy()}
          onClose={() => {
            focusNext.current = "opener";
            setError("");
            setKept(draft);
            setDraft(null);
          }}
        />
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">{live}</p>
      {error ? <p className="notice notice-error mt-2" role="alert">{error}</p> : null}
    </div>
  );
}
