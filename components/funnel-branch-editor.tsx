import { useId } from "react";
import type { PageFunnelStep } from "@/lib/page-funnel";
import { BRANCH_IFS, BRANCH_MAX_RULES, type BranchIf, cleanBranchValue, readsTag } from "@/lib/funnel-branch-rules";
import type { SplitChoice } from "@/lib/funnel-split-draft";
import { BRANCH_EXPLAIN, BRANCH_IF_LABELS, type BranchDraft, addRule, checkBranchDraft, freeBranchChoices, removeRule } from "@/lib/funnel-branch-draft";

const keyOf = (place: { kind: string; id: string }) => `${place.kind}:${place.id}`;

/**
 * The form to build or edit a funnel's conditional path (526 [FN2], unit 5),
 * drawn inside the funnel editor like the split test's form
 * (components/funnel-split-editor.tsx). Everything is done by click or
 * keyboard: the place is a list to choose from, never a drag (WCAG 2.5.7).
 * Each problem is said in words next to its field and tied to it (3.3.1,
 * 3.3.3); a review of where visitors go comes before the button, and the
 * button that would use a wrong path is off (3.3.6). "Use this conditional
 * path" changes only the draft: the funnel is saved with the editor's own
 * Save button, and the server checks it again.
 */
export function FunnelBranchEditor({
  draft,
  steps,
  choices,
  onChange,
  onApply,
  onCancel,
}: {
  draft: BranchDraft;
  steps: readonly PageFunnelStep[];
  choices: readonly SplitChoice[];
  onChange: (draft: BranchDraft) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const base = useId().replace(/:/g, "");
  const checked = checkBranchDraft(draft, steps, choices);
  const problems = checked.ok ? [] : checked.problems;
  const problemAt = (field: "if" | "value" | "to", index: number) => problems.find((p) => p.field === field && p.index === index)?.message ?? null;
  const fallbackError = problems.find((p) => p.field === "otherwise")?.message ?? null;
  const general = problems.filter((p) => p.field === "count" || p.field === "pages");
  const titleOf = (key: string) => choices.find((c) => keyOf(c) === key)?.title ?? "No longer available";
  const stepTitle = (step: PageFunnelStep) =>
    step.kind === "split" ? "a split test" : step.kind === "branch" ? "a conditional path" : choices.find((c) => keyOf(c) === keyOf(step))?.title ?? "No longer available";
  const canAdd = addRule(draft, steps, choices) !== draft;
  const place = draft.editing ?? draft.at;
  const setRule = (index: number, change: Partial<BranchDraft["rules"][number]>) =>
    onChange({ ...draft, rules: draft.rules.map((rule, i) => (i === index ? { ...rule, ...change } : rule)) });
  const listFor = (slot: number, key: string) => {
    const own = freeBranchChoices(draft, steps, choices, slot);
    return own.some((c) => keyOf(c) === key) ? own : [...own, choices.find((c) => keyOf(c) === key) ?? { kind: "page" as const, id: key, title: titleOf(key) }];
  };
  const ruleWords = (rule: BranchDraft["rules"][number]) =>
    readsTag(rule) ? `${BRANCH_IF_LABELS[rule.if]} "${cleanBranchValue(rule.if as "source" | "campaign", rule.value) || "?"}"` : BRANCH_IF_LABELS[rule.if];
  const errorText = (id: string, message: string | null) =>
    message ? (
      <p id={id} className="mt-1 text-sm font-semibold text-danger-text">
        {`Error: ${message}`}
      </p>
    ) : null;

  return (
    <section aria-labelledby={`${base}-title`} className="card mt-4 min-w-0 p-4 sm:p-5">
      <h3 id={`${base}-title`} tabIndex={-1} className="font-semibold text-ink" data-branch-editor-title>
        {draft.editing === null ? "Add a conditional path" : `Edit the conditional path, step ${draft.editing + 1}`}
      </h3>
      <p className="mt-1 text-sm text-ink-soft">{BRANCH_EXPLAIN}</p>

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
        <legend className="field-label">{`Rules, checked in order (1 to ${BRANCH_MAX_RULES})`}</legend>
        <ol className="mt-2 space-y-3">
          {draft.rules.map((rule, index) => {
            const ifError = problemAt("if", index);
            const valueError = problemAt("value", index);
            const toError = problemAt("to", index);
            return (
              <li key={index} className="rounded-xl border border-line p-3">
                <fieldset className="min-w-0">
                  <legend className="text-sm font-semibold text-ink">{`Rule ${index + 1}`}</legend>
                  <label className="mt-2 block" htmlFor={`${base}-if-${index}`}>
                    <span className="field-label">If</span>
                    <select
                      id={`${base}-if-${index}`}
                      className="field"
                      value={rule.if}
                      aria-invalid={ifError ? true : undefined}
                      aria-describedby={ifError ? `${base}-if-${index}-error` : undefined}
                      onChange={(e) => setRule(index, { if: e.target.value as BranchIf })}
                    >
                      {BRANCH_IFS.map((kind) => (
                        <option key={kind} value={kind}>{BRANCH_IF_LABELS[kind]}</option>
                      ))}
                    </select>
                  </label>
                  {errorText(`${base}-if-${index}-error`, ifError)}
                  {readsTag(rule) ? (
                    <>
                      <label className="mt-2 block" htmlFor={`${base}-value-${index}`}>
                        <span className="field-label">Tag word</span>
                        <input
                          id={`${base}-value-${index}`}
                          type="text"
                          autoComplete="off"
                          maxLength={40}
                          className="field"
                          value={rule.value}
                          aria-invalid={valueError ? true : undefined}
                          aria-describedby={`${base}-value-${index}-hint${valueError ? ` ${base}-value-${index}-error` : ""}`}
                          onChange={(e) => setRule(index, { value: e.target.value })}
                        />
                      </label>
                      <p id={`${base}-value-${index}-hint`} className="mt-1 text-xs text-ink-soft">
                        {`For example, spring-sale matches links that end with ?${rule.if === "source" ? "utm_source" : "utm_campaign"}=spring-sale. Capital letters do not matter.`}
                      </p>
                      {errorText(`${base}-value-${index}-error`, valueError)}
                    </>
                  ) : null}
                  <label className="mt-2 block" htmlFor={`${base}-to-${index}`}>
                    <span className="field-label">Then go to</span>
                    <select
                      id={`${base}-to-${index}`}
                      className="field"
                      value={rule.to}
                      aria-invalid={toError ? true : undefined}
                      aria-describedby={toError ? `${base}-to-${index}-error` : undefined}
                      onChange={(e) => setRule(index, { to: e.target.value })}
                    >
                      {listFor(index, rule.to).map((c) => (
                        <option key={keyOf(c)} value={keyOf(c)}>{`${c.title}${c.kind === "product" ? " (product)" : ""}`}</option>
                      ))}
                    </select>
                  </label>
                  {errorText(`${base}-to-${index}-error`, toError)}
                  <button type="button" className="btn btn-ghost mt-2" disabled={draft.rules.length <= 1} aria-label={`Remove rule ${index + 1}`} onClick={() => onChange(removeRule(draft, index))}>
                    Remove
                  </button>
                </fieldset>
              </li>
            );
          })}
        </ol>
        {draft.rules.length < BRANCH_MAX_RULES ? (
          <button type="button" className="btn btn-ghost mt-3" disabled={!canAdd} onClick={() => onChange(addRule(draft, steps, choices))}>
            {`Add a rule (${draft.rules.length} of ${BRANCH_MAX_RULES})`}
          </button>
        ) : null}
      </fieldset>

      <label className="mt-4 block" htmlFor={`${base}-otherwise`}>
        <span className="field-label">Everyone else goes to</span>
        <select
          id={`${base}-otherwise`}
          className="field"
          value={draft.otherwise}
          aria-invalid={fallbackError ? true : undefined}
          aria-describedby={fallbackError ? `${base}-otherwise-error` : undefined}
          onChange={(e) => onChange({ ...draft, otherwise: e.target.value })}
        >
          {listFor(-1, draft.otherwise).map((c) => (
            <option key={keyOf(c)} value={keyOf(c)}>{`${c.title}${c.kind === "product" ? " (product)" : ""}`}</option>
          ))}
        </select>
      </label>
      {errorText(`${base}-otherwise-error`, fallbackError)}

      {general.map((p) => (
        <p key={p.field} className="notice notice-error mt-3 text-sm">{p.message}</p>
      ))}

      <div className="mt-4 rounded-xl bg-paper p-3 text-sm text-ink ring-1 ring-line">
        <p className="font-semibold">{`Visitors who reach this step go to (step ${place + 1}):`}</p>
        <ol className="mt-1 list-decimal pl-5">
          {draft.rules.map((rule, i) => (
            <li key={i}>{`${ruleWords(rule)}: ${titleOf(rule.to)}`}</li>
          ))}
        </ol>
        <p className="mt-1">{`Everyone else: ${titleOf(draft.otherwise)}`}</p>
        <p className="mt-1 text-xs text-ink-soft">This changes the draft only. Save the funnel to keep it. Changing a conditional path starts its numbers over.</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={!checked.ok} onClick={onApply}>
          Use this conditional path
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
