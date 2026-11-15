import { useId } from "react";
import type { PageFunnelStep } from "@/lib/page-funnel";
import { SPLIT_MAX, SPLIT_MIN, equalShares } from "@/lib/funnel-split-rules";
import {
  SPLIT_EXPLAIN,
  type SplitChoice,
  type SplitDraft,
  addDestination,
  checkSplitDraft,
  freeChoices,
  removeDestination,
  setEqual,
  totalWords,
} from "@/lib/funnel-split-draft";

const keyOf = (place: { kind: string; id: string }) => `${place.kind}:${place.id}`;
const VERSION = ["A", "B", "C", "D"];

/**
 * The form to build or edit a funnel's split test (526 [FN2], unit 4), drawn
 * inside the funnel editor. Everything is done by click or keyboard: the
 * place is a list to choose from, never a drag (WCAG 2.5.7). Each problem is
 * said in words next to its field and tied to it (3.3.1, 3.3.3); the total of
 * the shares is said in a live region as it changes; a review of where
 * visitors go comes before the button, and the button that would use a wrong
 * split is off (3.3.6). "Use this split test" changes only the draft: the
 * funnel is saved with the editor's own Save button, and the server checks
 * it again.
 */
export function FunnelSplitEditor({
  draft,
  steps,
  choices,
  onChange,
  onApply,
  onCancel,
}: {
  draft: SplitDraft;
  steps: readonly PageFunnelStep[];
  choices: readonly SplitChoice[];
  onChange: (draft: SplitDraft) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const base = useId().replace(/:/g, "");
  const checked = checkSplitDraft(draft, steps, choices);
  const problems = checked.ok ? [] : checked.problems;
  const problemAt = (field: "option" | "share", index: number) => problems.find((p) => p.field === field && p.index === index)?.message ?? null;
  const general = problems.filter((p) => p.field === "count" || p.field === "pages");
  const titleOf = (key: string) => choices.find((c) => keyOf(c) === key)?.title ?? "No longer available";
  const shares = draft.equal ? equalShares(draft.options.length).map(String) : draft.shares;
  const stepTitle = (step: PageFunnelStep) =>
    step.kind === "split" ? "a split test" : step.kind === "branch" ? "a conditional path" : choices.find((c) => keyOf(c) === keyOf(step))?.title ?? "No longer available";
  const canAdd = addDestination(draft, steps, choices) !== draft;
  const place = draft.editing ?? draft.at;

  return (
    <section aria-labelledby={`${base}-title`} className="card mt-4 min-w-0 p-4 sm:p-5">
      <h3 id={`${base}-title`} tabIndex={-1} className="font-semibold text-ink" data-split-editor-title>
        {draft.editing === null ? "Add a split test" : `Edit the split test, step ${draft.editing + 1}`}
      </h3>
      <p className="mt-1 text-sm text-ink-soft">{SPLIT_EXPLAIN}</p>

      {draft.editing === null ? (
        <label className="mt-4 block" htmlFor={`${base}-at`}>
          <span className="field-label">Where it goes</span>
          <select id={`${base}-at`} className="field" value={draft.at} onChange={(e) => onChange({ ...draft, at: Number(e.target.value) })}>
            <option value={0}>First, before step 1</option>
            {steps.map((step, i) => (
              <option key={i} value={i + 1}>{`After step ${i + 1}: ${stepTitle(step)}`}</option>
            ))}
          </select>
        </label>
      ) : null}

      <fieldset className="mt-4 min-w-0">
        <legend className="field-label">{`Pages to split visitors between (${SPLIT_MIN} to ${SPLIT_MAX})`}</legend>
        <ol className="mt-2 space-y-3">
          {draft.options.map((key, index) => {
            const own = freeChoices(draft, steps, choices, index);
            const listed = own.some((c) => keyOf(c) === key) ? own : [...own, { ...(choices.find((c) => keyOf(c) === key) ?? { kind: "page" as const, id: key, title: titleOf(key) }) }];
            const optionError = problemAt("option", index);
            const shareError = problemAt("share", index);
            const title = titleOf(key);
            return (
              <li key={`${index}-${key}`} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block min-w-0 flex-1" htmlFor={`${base}-option-${index}`}>
                    <span className="field-label">{`Version ${VERSION[index] ?? index + 1}`}</span>
                    <select
                      id={`${base}-option-${index}`}
                      className="field"
                      value={key}
                      aria-invalid={optionError ? true : undefined}
                      aria-describedby={optionError ? `${base}-option-${index}-error` : undefined}
                      onChange={(e) => onChange({ ...draft, options: draft.options.map((k, i) => (i === index ? e.target.value : k)) })}
                    >
                      {listed.map((c) => (
                        <option key={keyOf(c)} value={keyOf(c)}>{`${c.title}${c.kind === "product" ? " (product)" : ""}`}</option>
                      ))}
                    </select>
                  </label>
                  {draft.equal ? (
                    <p className="min-h-11 py-2 text-sm text-ink">{`${shares[index]}% of visitors`}</p>
                  ) : (
                    <label className="block w-28" htmlFor={`${base}-share-${index}`}>
                      <span className="sr-only">{`Share for ${title}, in percent`}</span>
                      <span aria-hidden="true" className="field-label">Share</span>
                      <span className="flex items-center gap-1">
                        <input
                          id={`${base}-share-${index}`}
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={2}
                          className="field"
                          value={draft.shares[index] ?? ""}
                          aria-invalid={shareError ? true : undefined}
                          aria-describedby={shareError ? `${base}-share-${index}-error` : undefined}
                          onChange={(e) => onChange({ ...draft, shares: draft.options.map((_, i) => (i === index ? e.target.value : draft.shares[i] ?? "")) })}
                        />
                        <span aria-hidden="true">%</span>
                      </span>
                    </label>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={draft.options.length <= SPLIT_MIN}
                    aria-label={`Remove ${title} from the split test`}
                    onClick={() => onChange(removeDestination(draft, index))}
                  >
                    Remove
                  </button>
                </div>
                {optionError ? (
                  <p id={`${base}-option-${index}-error`} className="mt-1 text-sm font-semibold text-danger-text">
                    {`Error: ${optionError}`}
                  </p>
                ) : null}
                {shareError ? (
                  <p id={`${base}-share-${index}-error`} className="mt-1 text-sm font-semibold text-danger-text">
                    {`Error: ${shareError}`}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
        {draft.options.length < SPLIT_MAX ? (
          <button type="button" className="btn btn-ghost mt-3" disabled={!canAdd} onClick={() => onChange(addDestination(draft, steps, choices))}>
            {`Add a page (${draft.options.length} of ${SPLIT_MAX})`}
          </button>
        ) : null}
      </fieldset>

      <fieldset className="mt-4">
        <legend className="field-label">How to share visitors</legend>
        <label className="flex min-h-11 items-center gap-3 text-sm text-ink" htmlFor={`${base}-equal`}>
          <input id={`${base}-equal`} type="radio" name={`${base}-mode`} className="h-5 w-5" checked={draft.equal} onChange={() => onChange(setEqual(draft, true))} />
          Split equally
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm text-ink" htmlFor={`${base}-custom`}>
          <input id={`${base}-custom`} type="radio" name={`${base}-mode`} className="h-5 w-5" checked={!draft.equal} onChange={() => onChange(setEqual(draft, false))} />
          Set the shares myself, in whole percents that add up to 100
        </label>
      </fieldset>
      <p aria-live="polite" className="mt-2 text-sm font-semibold text-ink">{totalWords(draft)}</p>

      {general.map((p) => (
        <p key={p.field} className="notice notice-error mt-3 text-sm">{p.message}</p>
      ))}

      <div className="mt-4 rounded-xl bg-paper p-3 text-sm text-ink ring-1 ring-line">
        <p className="font-semibold">{`Visitors who reach this step go to (step ${place + 1}):`}</p>
        <ul className="mt-1 list-disc pl-5">
          {draft.options.map((key, i) => (
            <li key={`${i}-${key}`}>{`Version ${VERSION[i] ?? i + 1}: ${titleOf(key)}, ${shares[i] ?? "?"}% of visitors`}</li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-ink-soft">This changes the draft only. Save the funnel to keep it. Changing a split test starts its numbers over.</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={!checked.ok} onClick={onApply}>
          Use this split test
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
