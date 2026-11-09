"use client";

import { useId } from "react";
import { AI_DRAFT_BADGE, AI_DRAFT_CHECKS, ESTIMATE_BADGE, reviewDone, sensitiveWarning, type SensitiveTopic } from "@/lib/ai-draft-review";

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
  /** What the draft is about that needs a reader who knows it: health, money, the law (756 [STN3], unit 2). */
  topics?: readonly SensitiveTopic[];
  /** Numbers in the draft that the creator did not give, each shown as an estimate (756 [STN3], unit 3). */
  estimates?: readonly string[];
}) {
  const base = useId();
  const done = reviewDone(checks);
  const warning = sensitiveWarning(topics);
  return (
    <fieldset className="rounded-xl border border-line bg-white p-3" data-ai-review>
      <legend className="flex flex-wrap items-center gap-2 px-1 text-sm font-semibold text-ink">
        <span className="rounded-full border border-ink px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-ink">{AI_DRAFT_BADGE}</span>
        <span>Before you save it, check:</span>
      </legend>
      {warning ? (
        <p className="mt-1 text-sm text-ink">
          <strong>Sensitive topic:</strong> {warning}
        </p>
      ) : null}
      {estimates.length ? (
        <div className="mt-2 text-sm text-ink">
          <p>These numbers are not in what you gave. Check each one, or change it to a figure you know.</p>
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
