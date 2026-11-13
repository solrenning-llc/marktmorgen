"use client";

import { createContext, useContext, useId, useState } from "react";
import { readAiAnswer } from "@/lib/ai-response";
import { Icon } from "@/components/icons";
import { MAX_AI_NOTES } from "@/lib/ai-rules";
import { AiDraftReview } from "@/components/ai-draft-review";
import { draftStrings, draftTopics, freshChecks, reviewDone, type DraftTopics } from "@/lib/ai-draft-review";

/**
 * Whether the writing help (lib/ai.ts) is there for this person on this page,
 * and how many jobs are left this month. `known: false` when the allowance could
 * not be read (aiLeft threw): said in words and never shown as 0 (read it with
 * `allowanceOf`). Off outside a provider, so a page that never says it is on
 * never shows a button that cannot work.
 */
export const AiOn = createContext<{ on: boolean; left: number; known?: false }>({ on: false, left: 0 });

/** The month's allowance from AiOn: a count, or null when it could not be read. */
export const allowanceOf = (ai: { left: number; known?: false }): number | null => (ai.known === false ? null : ai.left);

/** What every AI box says when the month's allowance could not be read (rule 24, VR item 2): never "0 left". */
export const AI_ALLOWANCE_UNKNOWN = "We could not check your AI allowance just now. Reload the page in a minute to try again.";

const REFUSED_BEFORE_START = new Set(["long", "invalid", "unknown"]);

const MESSAGES: Record<string, string> = {
  unconfirmed: "The writing result could not be confirmed. Review your current content and check your writing allowance before trying again.",
  notes: "Write a few words about it first: what it is, who it is for, what is inside.",
  used: "This month's writing help is used up. It starts again with your next billing month.",
  slow: "A few at a time: wait a minute, then try again.",
  failed: "The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance. Try again in a moment.",
  off: "The writing help is not available right now.",
  forbidden: "Your role on this store cannot do this.",
  file: "The product's PDF could not be read. Draft the page without it, or upload the PDF again.",
};

/**
 * A box that asks for a few words and fills the studio's own fields with a
 * draft. It never saves: the creator reads it, changes it, and presses the
 * page's own Save — or doesn't.
 */
export function AiAssist<T>({
  title,
  hint,
  placeholder,
  payload,
  onResult,
  done,
  extra,
  allowEmpty = false,
  emptyMessage,
  onBusyChange,
  validateResult,
  onReviewChange,
}: {
  /** The line that opens it, like "Write the description for me". */
  title: string;
  hint: string;
  placeholder: string;
  /** What is sent besides the notes: the kind of job and what it needs. */
  payload: () => Record<string, unknown>;
  onResult: (value: T) => void;
  /** Said once the fields are filled. */
  done: string;
  /** Any choice the job needs, drawn above the box. */
  extra?: React.ReactNode;
  /**
   * The job has enough to go on without the box: a sales page is drafted
   * from what the product already says, so the box only adds to it.
   */
  allowEmpty?: boolean;
  /** What is said when the job had nothing to go on, where the usual words do not fit it. */
  emptyMessage?: string;
  /** Lets a host pause conflicting actions while writing is pending. */
  onBusyChange?: (busy: boolean) => void;
  /** Optional host-specific result validation before applying any content. */
  validateResult?: (value: unknown) => value is T;
  /**
   * Told whether the draft it filled in is checked (756 [STN3]): false as each
   * new draft is filled, true once the creator checks all three boxes under it.
   * A form that saves the draft waits on it.
   */
  onReviewChange?: (reviewed: boolean) => void;
}) {
  const { on, left: startLeft } = useContext(AiOn);
  // Unknown from the start when the page could not read it (known: false); nothing is started on a guess.
  const startKnown = allowanceOf(useContext(AiOn)) !== null;
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filled, setFilled] = useState(false);
  // A confirmed draft sits in the fields (756 [STN3]). Only a new confirmed draft sets it, and
  // nothing clears it: a later attempt that fails leaves that draft, and its checks, where they are.
  const [drafted, setDrafted] = useState(false);
  // The three checks under the draft it filled in (756 [STN3]).
  const [checks, setChecks] = useState<boolean[]>(freshChecks);
  // What the draft is about that needs a reader who knows it (756 [STN3], unit 2), read from its own words.
  const [topics, setTopics] = useState<DraftTopics>([]);
  const [left, setLeft] = useState(startLeft);
  const [allowanceKnown, setAllowanceKnown] = useState(startKnown);
  const [readOnce, setReadOnce] = useState(startKnown);
  const allowanceId = useId();
  if (!on) return null;

  async function run() {
    if (busy) return;
    // Said here, before a round trip that would only come back with the same.
    if (!allowEmpty && !notes.trim()) {
      setError(MESSAGES.notes);
      return;
    }
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    setFilled(false);
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload(), notes }),
      });
      const data = readAiAnswer(response.ok, await response.json().catch(() => null));
      if (data.ok) {
        setLeft(data.left);
        setAllowanceKnown(true);
        setReadOnce(true);
        if (validateResult && !validateResult(data.value)) { setError(MESSAGES.unconfirmed); return; }
        onResult(data.value as T);
        // Every new draft is checked afresh, whatever was checked for the one before.
        setChecks(freshChecks());
        // Each string as written, never the JSON text, where "\nInvesting" reads as "nInvesting"; in the draft's language.
        setTopics(draftTopics(draftStrings(data.value), data.language));
        onReviewChange?.(false);
        setDrafted(true);
        setFilled(true);
        return;
      }
      // Refusals the server returns before any attempt starts keep main's retryable message.
      const refused = REFUSED_BEFORE_START.has(data.error);
      if (!refused && (data.error === "unconfirmed" || !Object.hasOwn(MESSAGES, data.error))) setAllowanceKnown(false);
      setError(data.error === "notes" && emptyMessage ? emptyMessage : refused ? MESSAGES.failed : (Object.hasOwn(MESSAGES, data.error) ? MESSAGES[data.error] : MESSAGES.unconfirmed));
    } catch {
      setAllowanceKnown(false);
      setError(MESSAGES.unconfirmed);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <details className="rounded-2xl border border-violet-brand/25 bg-lilac/40 px-4 py-3">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold text-violet-deep">
        <Icon name="sparkle" size={16} />
        {title}
      </summary>
      <div className="mt-2 space-y-3 pb-1">
        <p className="text-sm text-ink-soft">{hint}</p>
        {extra}
        <label className="block">
          <span className="sr-only">What it should say</span>
          <textarea
            className="field"
            rows={4}
            maxLength={MAX_AI_NOTES}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={placeholder}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void run()} disabled={busy || !allowanceKnown || left <= 0} aria-busy={busy} aria-describedby={allowanceId}>
            {busy ? "Writing…" : "Write a draft"}
          </button>
          <span id={allowanceId} className="text-xs text-ink-soft">{allowanceKnown ? `${left} left this month. Started attempts count, even if they fail.` : readOnce ? "Reload to check your writing allowance before trying again." : AI_ALLOWANCE_UNKNOWN}</span>
        </div>
        {error ? (
          <p className="notice notice-error text-sm" role="alert">
            {error}
          </p>
        ) : filled ? (
          <p className="text-sm font-semibold text-ink" role="status">
            {done}
          </p>
        ) : null}
        {drafted ? (
          <AiDraftReview
            checks={checks}
            topics={topics}
            onToggle={(index, ticked) => {
              const next = checks.map((was, at) => (at === index ? ticked : was));
              setChecks(next);
              onReviewChange?.(reviewDone(next));
            }}
          />
        ) : null}
        <p className="text-xs text-ink-soft">
          It uses only your own words, here and in your store, never invents reviews, numbers, results or deadlines, and saves nothing until you
          do. Read it before you publish: it is yours.
        </p>
      </div>
    </details>
  );
}
