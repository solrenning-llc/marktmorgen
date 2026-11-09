"use client";

import { useId } from "react";
import { AI_DRAFT_BADGE, AI_DRAFT_CHECKS, ESTIMATE_BADGE, ESTIMATE_NOTE, reviewDone, sensitiveLabel, sensitiveWarning, type DraftTopics } from "@/lib/ai-draft-review";

/**
 * The "AI draft" badge and the three checks drawn under every draft the
 * writing help fills in (756 [STN3], unit 1). The badge is words, not a color;
 * each check is a real checkbox in a 44 px row, grouped under a legend, so it
 * works by keyboard and is read by a screen reader. The form that saves finds
 * the first one left by `data-ai-review`.
 */
export function AiDraftReview({
  checks,
  onToggle,
  topics = [],
  estimates = [],
}: {
  checks: readonly boolean[];
  onToggle: (index: number, ticked: boolean) => void;
  /**
   * What the draft is about that needs a reader who knows it: health, money, the law,
   * or "unread" for a draft in a language the lists do not read (756 [STN3], unit 2).
   */
  topics?: DraftTopics;
  /** Numbers in the draft that the creator did not give, each shown as an estimate (756 [STN3], unit 3). */
  estimates?: readonly string[];
}) {
  const base = useId();
  const done = reviewDone(checks);
  const warning = sensitiveWarning(topics);
  const warningId = `${base}-topic`;
  const estimatesId = `${base}-estimates`;
  // The warning and the numbers to check describe the group, so a screen reader reads them with the checks
  // (Claude 6's reviews of #3436, LOW 5, and #3437, LOW 6).
  const describedBy = [warning ? warningId : null, estimates.length ? estimatesId : null].filter(Boolean).join(" ") || undefined;
  return (
    <fieldset className="rounded-xl border border-line bg-white p-3" data-ai-review aria-describedby={describedBy}>
      <legend className="flex flex-wrap items-center gap-2 px-1 text-sm font-semibold text-ink">
        <span className="rounded-full border border-ink px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-ink">{AI_DRAFT_BADGE}</span>
        <span>Before you save it, check:</span>
      </legend>
      {warning ? (
        <p id={warningId} className="mt-1 text-sm text-ink">
          <strong>{sensitiveLabel(topics)}</strong> {warning}
        </p>
      ) : null}
      {estimates.length ? (
        <div id={estimatesId} className="mt-2 text-sm text-ink">
          <p>{ESTIMATE_NOTE}</p>
          <ul className="mt-1 flex flex-wrap gap-2" aria-label="Numbers to check">
            {estimates.map((figure) => (
              <li key={figure} className="inline-flex items-center gap-1">
                <span className="rounded-full border border-ink px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-ink">{ESTIMATE_BADGE}</span>
                <span className="font-semibold">{figure}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="mt-1 space-y-1">
        {AI_DRAFT_CHECKS.map((check, index) => (
          <li key={check.id}>
            <label htmlFor={`${base}-${check.id}`} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-ink">
              <input
                id={`${base}-${check.id}`}
                type="checkbox"
                className="h-5 w-5 shrink-0"
                checked={checks[index] === true}
                onChange={(event) => onToggle(index, event.target.checked)}
              />
              <span>{check.label}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-sm text-ink-soft" role="status">
        {done ? "Checked. You can save it." : "Check each box once you have read the draft."}
      </p>
    </fieldset>
  );
}
