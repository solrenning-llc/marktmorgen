"use client";

import { useId } from "react";
import { AI_DRAFT_BADGE, AI_DRAFT_CHECKS, reviewDone } from "@/lib/ai-draft-review";

/**
 * The "AI draft" badge and the three checks drawn under every draft the
 * writing help fills in (756 [STN3], unit 1). The badge is words, not a color;
 * each check is a real checkbox in a 44 px row, grouped under a legend, so it
 * works by keyboard and is read by a screen reader. The form that saves finds
 * the first one left by `data-ai-review`.
 */
export function AiDraftReview({ checks, onToggle }: { checks: readonly boolean[]; onToggle: (index: number, ticked: boolean) => void }) {
  const base = useId();
  const done = reviewDone(checks);
  return (
    <fieldset className="rounded-xl border border-line bg-white p-3" data-ai-review>
      <legend className="flex flex-wrap items-center gap-2 px-1 text-sm font-semibold text-ink">
        <span className="rounded-full border border-ink px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-ink">{AI_DRAFT_BADGE}</span>
        <span>Before you save it, check:</span>
      </legend>
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
