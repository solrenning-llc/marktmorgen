"use client";

import { useContext, useId, useState } from "react";
import { AiOn, allowanceOf } from "@/components/ai-assist";
import { Icon } from "@/components/icons";
import { readAiAnswer } from "@/lib/ai-response";
import { MAX_AI_NOTES } from "@/lib/ai-rules";
import { IDEAS_COPY, type ProductIdea, ideasReadyWords, readIdeas } from "@/lib/product-ideas-rules";
import { AiDraftReview } from "@/components/ai-draft-review";
import { freshChecks } from "@/lib/ai-draft-review";

/** What the box says for each answer the route refuses with (its own words; components/ai-assist.tsx keeps its own). */
const REFUSALS: Record<string, string> = {
  notes: IDEAS_COPY.notes,
  used: IDEAS_COPY.used_up,
  slow: IDEAS_COPY.slow,
  failed: IDEAS_COPY.failed,
  off: IDEAS_COPY.off,
  forbidden: IDEAS_COPY.forbidden,
};

/**
 * "Get product ideas" in the form that adds a product (758 [STN5], unit 2;
 * lib/product-ideas.ts). It asks the writing help for ideas, lists them, and
 * "Use this idea" fills the form's name and short description; the creator
 * reads them, changes anything, and presses the form's own Add button, or
 * puts back what the boxes had. It saves nothing itself, and is drawn only
 * while the writing help is on for this person.
 */
export function ProductIdeas({
  title,
  summary,
  titleFieldId,
  onUse,
  onReviewChange,
}: {
  /** What the form's name and short description hold now, put back by the undo. */
  title: string;
  summary: string;
  /** The name field, where the focus goes once an idea fills it. */
  titleFieldId: string;
  onUse: (next: { title: string; summary: string }) => void;
  /**
   * The checks of the AI-draft review drawn under an idea used (756 [STN3]; cloud I on #3441): afresh at each idea, as
   * the creator checks them, and null when "Put back what you had" takes the idea out, so the form holds its save
   * while an idea's words are not checked and puts back its own checks after an undo.
   */
  onReviewChange?: (checks: boolean[] | null) => void;
}) {
  const ai = useContext(AiOn);
  const { on } = ai;
  const [left, setLeft] = useState(ai.left);
  const [allowanceKnown, setAllowanceKnown] = useState(allowanceOf(ai) !== null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [ideas, setIdeas] = useState<ProductIdea[]>([]);
  const [before, setBefore] = useState<{ title: string; summary: string } | null>(null);
  // The review of the idea in the form: null while none is.
  const [checks, setChecks] = useState<boolean[] | null>(null);
  const notesId = useId();
  const allowanceId = useId();
  const listId = useId();
  if (!on) return null;

  async function ask() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "ideas", notes }),
      });
      const data = readAiAnswer(response.ok, await response.json().catch(() => null));
      if (data.ok) {
        setLeft(data.left);
        setAllowanceKnown(true);
        const read = readIdeas(data.value);
        if (!read) {
          setError(IDEAS_COPY.unconfirmed);
          return;
        }
        // New ideas keep the undo: it still puts back what the boxes had before the first idea used.
        setIdeas(read);
        setStatus(ideasReadyWords(read.length));
        return;
      }
      if (!Object.hasOwn(REFUSALS, data.error)) setAllowanceKnown(false);
      setError(Object.hasOwn(REFUSALS, data.error) ? REFUSALS[data.error] : IDEAS_COPY.unconfirmed);
    } catch {
      setAllowanceKnown(false);
      setError(IDEAS_COPY.unconfirmed);
    } finally {
      setBusy(false);
    }
  }

  function use(idea: ProductIdea) {
    // The undo puts back what the boxes had before the first idea used, not an idea used before this one.
    setBefore((kept) => kept ?? { title, summary });
    onUse({ title: idea.title, summary: idea.who });
    const fresh = freshChecks();
    setChecks(fresh);
    onReviewChange?.(fresh);
    setStatus(IDEAS_COPY.used);
    // The creator asked for it: the focus goes to the name it filled, to read and change.
    document.getElementById(titleFieldId)?.focus();
  }

  function undo() {
    if (!before) return;
    onUse(before);
    setBefore(null);
    setChecks(null);
    onReviewChange?.(null);
    setStatus(IDEAS_COPY.undone);
  }

  return (
    <details className="rounded-2xl border border-violet-brand/25 bg-lilac/40 px-4 py-3">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold text-violet-deep">
        <Icon name="sparkle" size={16} />
        {IDEAS_COPY.opener}
      </summary>
      <div className="mt-2 space-y-3 pb-1">
        <p className="text-sm text-ink-soft">{IDEAS_COPY.hint}</p>
        <div>
          <label htmlFor={notesId} className="field-label">
            {IDEAS_COPY.notesLabel}
          </label>
          <textarea
            id={notesId}
            className="field mt-2"
            rows={3}
            maxLength={MAX_AI_NOTES}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={IDEAS_COPY.notesExample}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="btn btn-secondary btn-sm inline-flex min-h-11 items-center"
            type="button"
            disabled={busy || !allowanceKnown || left <= 0}
            aria-busy={busy}
            aria-describedby={allowanceId}
            onClick={() => void ask()}
          >
            {busy ? IDEAS_COPY.asking : IDEAS_COPY.ask}
          </button>
          <span id={allowanceId} className="text-xs text-ink-soft">
            {allowanceKnown ? `${left} ${IDEAS_COPY.allowance}` : IDEAS_COPY.unknownAllowance}
          </span>
        </div>
        <p className="text-xs text-ink-soft">{IDEAS_COPY.note}</p>
        <p role="status" aria-live="polite" className="text-sm font-semibold text-ink">
          {status}
        </p>
        {error ? (
          <p role="alert" className="notice notice-error text-sm">
            {error}
          </p>
        ) : null}
        {before ? (
          <button className="btn btn-ghost btn-sm inline-flex min-h-11 items-center" type="button" onClick={undo}>
            {IDEAS_COPY.undo}
          </button>
        ) : null}
        {ideas.length ? (
          <section aria-labelledby={listId} className="space-y-2">
            <h3 id={listId} className="text-sm font-semibold text-ink">
              {IDEAS_COPY.badge}
            </h3>
            <ol className="space-y-3">
              {ideas.map((idea) => (
                <li key={idea.title} className="rounded-xl border border-violet-brand/20 bg-white p-3">
                  <h4 className="font-semibold text-ink">{idea.title}</h4>
                  <p className="mt-1 text-sm text-ink">
                    <span className="font-semibold">{IDEAS_COPY.who}</span> {idea.who}
                  </p>
                  <p className="mt-1 text-sm text-ink">
                    <span className="font-semibold">{IDEAS_COPY.why}</span> {idea.why}
                  </p>
                  <button className="btn btn-secondary btn-sm mt-2 inline-flex min-h-11 items-center" type="button" onClick={() => use(idea)}>
                    {IDEAS_COPY.use}<span className="sr-only">: {idea.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {checks ? (
          <AiDraftReview
            checks={checks}
            onToggle={(index, ticked) => {
              const next = checks.map((was, at) => (at === index ? ticked : was));
              setChecks(next);
              onReviewChange?.(next);
            }}
          />
        ) : null}
      </div>
    </details>
  );
}
