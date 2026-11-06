"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";
import {
  MAX_CATEGORIES,
  MAX_CATEGORY_NAME,
  type Answers,
  type FormCategory,
  type FormDef,
  branches,
  maxScore,
  newFormId,
  outcomeOf,
  scoreOf,
  tierIssueText,
  tierIssues,
} from "@/lib/forms";

/**
 * The parts of the forms editor (components/forms-editor.tsx) that only a
 * scored quiz has (lib/forms.ts): its categories, a check that its score
 * ranges cover every possible total exactly once, a table of which total
 * gives which result, and a way to try answers and see the score and the
 * result they give, before anything is saved or anybody answers. Everything
 * here is the same arithmetic the server does when the answers arrive.
 */

export function QuizCategories({ categories, onChange }: { categories: FormCategory[]; onChange: (next: FormCategory[]) => void }) {
  return (
    <div className="mt-4">
      <p className="field-label">Categories (optional)</p>
      <p className="mt-1 text-xs text-ink-soft">
        {`Up to ${MAX_CATEGORIES}. An option's points can also count in one category, as "Mindset" or "Marketing", and each person sees their score in each one beside their total. Results are chosen by the total.`}
      </p>
      <ul className="mt-2 space-y-2">
        {categories.map((c, i) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2">
            {/* A visible name of its own, not a placeholder that goes when typing starts (487 [IT4], item 4). */}
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-sm text-ink-soft">{`Category ${i + 1}`}</span>
              <input
                className="field min-w-0 flex-1"
                value={c.name}
                maxLength={MAX_CATEGORY_NAME}
                placeholder="Mindset"
                onChange={(e) => onChange(categories.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
            </label>
            <button type="button" className="btn btn-secondary btn-sm" aria-label={`Remove category ${i + 1}`} onClick={() => onChange(categories.filter((_, j) => j !== i))}>
              <Icon name="minus" size={16} />
            </button>
          </li>
        ))}
      </ul>
      {categories.length < MAX_CATEGORIES ? (
        <button type="button" className="btn btn-secondary btn-sm mt-2" onClick={() => onChange([...categories, { id: newFormId(6), name: "" }])}>
          <Icon name="plus" size={16} />
          Add a category
        </button>
      ) : null}
    </div>
  );
}

/** The check, the table and the try-it panel, under a scored quiz's results. */
export function QuizScoringCheck({ form, onSpread }: { form: FormDef; onSpread: () => void }) {
  const [tried, setTried] = useState<Answers>({});
  const top = maxScore(form);
  const issues = tierIssues(form);
  const scored = form.fields.filter((f) => f.type === "choice" || f.type === "choices");
  const ranged = form.outcomes
    .map((o, i) => ({ ...o, at: i }))
    .filter((o) => typeof o.min === "number" && typeof o.max === "number")
    .sort((a, b) => (a.min ?? 0) - (b.min ?? 0));
  // Only answers to questions still there, and options still offered.
  const answers: Answers = Object.fromEntries(
    Object.entries(tried).flatMap(([id, value]): [string, string | string[]][] => {
      const field = scored.find((f) => f.id === id);
      if (!field) return [];
      const ok = (v: string) => field.options.some((o) => o.id === v);
      if (Array.isArray(value)) return [[id, value.filter(ok)]];
      return typeof value === "string" && ok(value) ? [[id, value]] : [];
    }),
  );
  const score = scoreOf(form, answers);
  const result = outcomeOf(form, answers);
  const name = (id: string) => form.categories?.find((c) => c.id === id)?.name || "Category";

  return (
    <div className="mt-6 rounded-2xl border border-line bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">Check the scoring</p>
          <p className="mt-1 text-sm text-ink-soft">
            {`Totals run from 0 to ${top.total}, the most anybody can score${branches(form) ? " if every question were asked" : ""}. Each total needs exactly one result.`}
          </p>
        </div>
        {form.outcomes.length && top.total > 0 ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onSpread}>
            Spread the ranges evenly
          </button>
        ) : null}
      </div>

      {issues.length ? (
        <ul className="notice notice-warn mt-4 space-y-1 text-sm" role="status" aria-live="polite">
          {issues.map((issue, i) => (
            <li key={i}>{tierIssueText(form, issue)}</li>
          ))}
          <li className="font-semibold">The quiz can be saved once each of these is fixed.</li>
        </ul>
      ) : (
        <p className="notice notice-success mt-4 text-sm" role="status" aria-live="polite">
          Every total from 0 to {top.total} has exactly one result.
        </p>
      )}

      {ranged.length ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[20rem] text-left text-sm">
            <thead>
              <tr className="text-ink-soft">
                <th scope="col" className="py-2 pr-4 font-semibold">Total</th>
                <th scope="col" className="py-2 pr-4 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {ranged.map((o) => (
                <tr key={o.id} className="border-t border-line">
                  <td className="whitespace-nowrap py-2 pr-4">{o.min === o.max ? String(o.min) : `${o.min} to ${o.max}`}</td>
                  <td className="py-2 pr-4">{o.title || `Result ${o.at + 1}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {scored.length ? (
        <div className="mt-5">
          <p className="field-label">Try it</p>
          <p className="mt-1 text-xs text-ink-soft">Pick answers as a person would. Nothing here is sent or kept.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {scored.map((field, i) =>
              field.type === "choice" ? (
                <label key={field.id} className="block min-w-0">
                  <span className="text-sm font-semibold text-ink">{field.label || `Question ${i + 1}`}</span>
                  <select
                    className="field mt-1"
                    value={typeof answers[field.id] === "string" ? (answers[field.id] as string) : ""}
                    onChange={(e) => setTried((t) => ({ ...t, [field.id]: e.target.value }))}
                  >
                    <option value="">No answer</option>
                    {field.options.map((o, k) => (
                      <option key={o.id} value={o.id}>{`${o.label || `Option ${k + 1}`} (${o.points ?? 0})`}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <fieldset key={field.id} className="min-w-0">
                  <legend className="text-sm font-semibold text-ink">{field.label || `Question ${i + 1}`}</legend>
                  {field.options.map((o, k) => {
                    const picked = Array.isArray(answers[field.id]) ? (answers[field.id] as string[]) : [];
                    return (
                      <label key={o.id} className="flex min-h-9 items-center gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          checked={picked.includes(o.id)}
                          onChange={(e) => setTried((t) => ({ ...t, [field.id]: e.target.checked ? [...picked, o.id] : picked.filter((x) => x !== o.id) }))}
                        />
                        {`${o.label || `Option ${k + 1}`} (${o.points ?? 0})`}
                      </label>
                    );
                  })}
                </fieldset>
              ),
            )}
          </div>
          <div className="mt-4 rounded-xl bg-paper p-3 text-sm ring-1 ring-line" role="status" aria-live="polite">
            {score && score.answered > 0 ? (
              <>
                <p className="font-semibold text-ink">{`Total: ${score.total} of ${top.total}`}</p>
                {Object.entries(score.categories).length ? (
                  <p className="mt-1 text-ink-soft">{Object.entries(score.categories).map(([id, n]) => `${name(id)}: ${n} of ${top.categories[id] ?? 0}`).join(" · ")}</p>
                ) : null}
                <p className="mt-1 text-ink">{result ? `They would see “${result.title || "an untitled result"}”.` : "No result covers this total yet, so they would see your thank-you instead."}</p>
              </>
            ) : (
              <p className="text-ink-soft">With no scored question answered, nothing is measured: a person sees your thank-you, not a result.</p>
            )}
          </div>
          {branches(form) ? <p className="mt-2 text-xs text-ink-soft">The answers above skip questions the way they will on the page: points on a skipped question do not count.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
