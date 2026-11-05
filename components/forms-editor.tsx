"use client";

import { FORM_STARTERS } from "@/lib/form-starters";
import { FormAnswers } from "@/components/form-answers";
import { FormResponseDeal } from "@/components/form-response-deal";
import { mergeFormOpportunities, type FormDealMatch } from "@/lib/form-deal";
import type { Stage } from "@/lib/crm-rules";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { useLeaveGuard } from "@/components/leave-guard";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { QuizCategories, QuizScoringCheck } from "@/components/quiz-scoring";
import {
  FIELD_TYPES,
  MAX_BUTTON,
  MAX_DONE_BODY,
  MAX_DONE_HEADING,
  MAX_FIELDS,
  MAX_FORM_NAME,
  MAX_FORMS,
  MAX_LABEL,
  MAX_OPTION,
  MAX_OPTIONS,
  MAX_OUTCOME_BODY,
  MAX_OUTCOME_TITLE,
  MAX_OUTCOMES,
  MAX_POINTS,
  MAX_SCORE,
  KEPT_RESPONSES,
  type FieldType,
  type FormDef,
  type FormField,
  type FormOutcome,
  type FormResponse,
  END,
  evenRanges,
  isScored,
  maxScore,
  newFormId,
} from "@/lib/forms";

/** One saved form, with how many answers it has kept and the newest of them. */
export type SavedForm = { form: FormDef; total: number; latest: (FormResponse & { opportunityRef?: string })[] };

const MESSAGES: Record<string, string> = {
  name: "Give the form a name. Only you see it.",
  fields: "A form needs at least one question with words, and each choice needs at least two options.",
  full: `A store can have ${MAX_FORMS} forms. Remove one to add another.`,
  unknown: "That form is already gone. Reload the page.",
  invalid: "Something in the form could not be read. Reload the page and try again.",
  points: `Each option's points must be a whole number from 0 to ${MAX_POINTS}.`,
  tiers: "The score ranges do not cover every total exactly once yet:",
  sensitive: "This form was not saved: a question asks for something a form never may.",
  server_error: "Saving could not be confirmed. Review the saved forms before trying again.",
  ...STUDIO_MESSAGES,
};

const piece = () => newFormId(6);
const hasOptions = (type: FieldType) => type === "choice" || type === "choices";

const blank = (): FormDef => ({
  id: "",
  name: "",
  fields: [{ id: piece(), type: "email", label: "Your email", required: true, options: [] }],
  button: "",
  doneHeading: "",
  doneBody: "",
  outcomes: [],
  offerList: false,
  updatedAt: 0,
});

/**
 * The studio's forms, surveys and quizzes (lib/forms.ts): each with how many
 * answers it has kept and the newest of them, a file of all of them, and an
 * editor for its questions, its results and what a person reads after.
 */
export function FormsEditor({ saved, products, exportBase, dealStages = [], sid = "", currency = "USD", dealAssignees = [], existingDeals = [], existingDealsAvailable = false }: { existingDealsAvailable?: boolean; existingDeals?: FormDealMatch[]; currency?: string; dealAssignees?: string[]; dealStages?: Stage[]; sid?: string; saved: SavedForm[]; products: { id: string; title: string }[]; /** The download's address, the form's id added at its end. */ exportBase: string }) {
  const router = useRouter();
  const [recorded, setRecorded] = useState<{ sid: string; deals: FormDealMatch[] }>({ sid, deals: [] });
  const knownDeals = mergeFormOpportunities(existingDeals, recorded.sid === sid ? recorded.deals : []);
  const rememberOpportunity = (deal: FormDealMatch) => setRecorded(current => ({ sid, deals: [...(current.sid === sid ? current.deals.filter(item => item.id !== deal.id) : []), deal] }));
  const [dealDraft, setDealDraft] = useState<{ form: FormDef; response: FormResponse; responseRef: string } | null>(null);
  const [draft, setDraft] = useState<FormDef | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  useLeaveGuard(draft !== null && !busy);

  const patch = (change: Partial<FormDef>) => setDraft((d) => (d ? { ...d, ...change } : d));
  const setField = (i: number, change: Partial<FormField>) =>
    setDraft((d) => (d ? { ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...change } : f)) } : d));
  const setOutcome = (i: number, change: Partial<FormOutcome>) =>
    setDraft((d) => (d ? { ...d, outcomes: d.outcomes.map((o, j) => (j === i ? { ...o, ...change } : o)) } : d));

  function moveField(i: number, by: -1 | 1) {
    setDraft((d) => {
      if (!d) return d;
      const to = i + by;
      if (to < 0 || to >= d.fields.length) return d;
      const swapped = d.fields.slice();
      [swapped[i], swapped[to]] = [swapped[to], swapped[i]];
      // An answer leads only forward: one that now points back goes on to the next question instead.
      const fields = swapped.map((f, at) => ({
        ...f,
        options: f.options.map((o) => (o.next && o.next !== END && swapped.findIndex((x) => x.id === o.next) <= at + 1 ? { ...o, next: "" } : o)),
      }));
      return { ...d, fields };
    });
  }

  async function send(body: unknown, done: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/forms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; issues?: string[] };
      if (data.ok) {
        toast(done);
        setDraft(null);
        setRemoving(null);
        router.refresh();
        return;
      }
      const said = MESSAGES[data.error ?? ""] ?? MESSAGES.server_error;
      const extra = data as { field?: unknown; why?: unknown };
      setError(
        data.error === "tiers" && Array.isArray(data.issues)
          ? `${said} ${data.issues.join(" ")}`
          : data.error === "sensitive" && typeof extra.field === "string"
            ? `${said} The question \u201c${extra.field}\u201d: ${typeof extra.why === "string" ? extra.why : ""} Change or remove it, then save. Nothing you wrote was changed.`
            : said,
      );
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const hasEmail = draft?.fields.some((f) => f.type === "email") ?? false;
  const scoredDraft = draft ? isScored(draft) : false;

  /** Switches a draft between results by pointing answers and results by score, keeping what each needs. */
  function setScoring(on: boolean) {
    setDraft((d) => {
      if (!d) return d;
      if (!on) {
        // Back to results by pointing answers: the points, categories and ranges are let go.
        return {
          id: d.id, name: d.name, button: d.button, doneHeading: d.doneHeading, doneBody: d.doneBody, offerList: d.offerList, updatedAt: d.updatedAt,
          ...(d.opensAt ? { opensAt: d.opensAt } : {}), ...(d.closesAt ? { closesAt: d.closesAt } : {}),
          outcomes: d.outcomes.map((o) => ({ id: o.id, title: o.title, body: o.body, product: o.product })),
          fields: d.fields.map((f) => ({ ...f, options: f.options.map((o) => ({ id: o.id, label: o.label, outcome: o.outcome, ...(o.next ? { next: o.next } : {}) })) })),
        };
      }
      const fields = d.fields.map((f) => ({ ...f, options: f.options.map((o) => ({ ...o, outcome: "", points: o.points ?? 0 })) }));
      const next: FormDef = { ...d, scoring: "points", categories: d.categories ?? [], fields };
      const ranges = evenRanges(maxScore(next).total, d.outcomes.length);
      return { ...next, outcomes: d.outcomes.map((o, i) => ({ ...o, min: o.min ?? ranges[i].min, max: o.max ?? ranges[i].max })) };
    });
  }
  // A new form, blank or from an example: the button pressed goes away with the list, so the focus moves to the form's name.
  const nameField = useRef<HTMLInputElement>(null);
  const openNew = (def: FormDef) => {
    setError(null);
    setDraft(def);
    requestAnimationFrame(() => nameField.current?.focus());
  };
  const spread = () =>
    setDraft((d) => {
      if (!d) return d;
      const ranges = evenRanges(maxScore(d).total, d.outcomes.length);
      return { ...d, outcomes: d.outcomes.map((o, i) => ({ ...o, ...ranges[i] })) };
    });
  const numberIn = (value: string, max: number) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
  };

  return (
    <section aria-labelledby="forms-title" className="card min-w-0 p-5 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h2 id="forms-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Forms, surveys and quizzes
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {`Questions you ask on one of your own pages, with a Form block: an application before a call, a survey, a quiz with results, chosen by answers or by score. Up to ${MAX_FIELDS} questions, and the newest ${KEPT_RESPONSES.toLocaleString("en-US")} answers of each kept for you, as a file too.`}
          </p>
        </div>
        {draft === null && saved.length < MAX_FORMS ? (
          <button type="button" className="btn btn-primary" disabled={dealDraft !== null} onClick={() => openNew(blank())}>
            <Icon name="plus" size={18} />
            New form
          </button>
        ) : null}
      </div>

      {saved.length === 0 && draft === null ? (
        <div className="mt-6 rounded-2xl bg-paper p-4 text-sm text-ink-soft ring-1 ring-line" data-form-starters="">
          <p>No forms yet. Make one, then add a Form block to one of your pages under Pages and choose it there.</p>
          {/* A ready example (487 [IT4], item 5): it opens in the editor below, unsaved, for you to change and save. */}
          <h3 id="form-starters-title" className="mt-3 font-semibold text-ink">Or start from an example</h3>
          <ul className="mt-2 space-y-2" aria-labelledby="form-starters-title">
            {FORM_STARTERS.map((starter) => (
              <li key={starter.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">{starter.name}</span>
                  <span className="block" id={`form-starter-${starter.id}`}>{starter.hint}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={dealDraft !== null}
                  aria-describedby={`form-starter-${starter.id}`}
                  onClick={() => openNew(starter.make(piece))}
                >
                  {`Use “${starter.name}”`}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2">Nothing is saved or shown on your pages until you save it and add it to a page.</p>
        </div>
      ) : null}

      <ul className="mt-6 space-y-4">
        {saved.map(({ form, total, latest }) => (
          <li key={form.id} id={`form-review-${form.id}`} className="scroll-mt-24 rounded-2xl border border-line bg-white p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                  {form.name}
                  {isScored(form) ? <span className="tag">Scored quiz</span> : form.outcomes.length ? <span className="tag">Quiz</span> : null}
                </p>
                <p className="mt-1 text-sm text-ink-soft">{`${form.fields.length} ${form.fields.length === 1 ? "question" : "questions"} · ${total.toLocaleString("en-US")} ${total === 1 ? "answer" : "answers"} kept`}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {total > 0 ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(open === form.id ? null : form.id)}>
                    {open === form.id ? "Hide answers" : "See answers"}
                  </button>
                ) : null}
                {total > 0 ? (
                  <a className="btn btn-secondary btn-sm" href={`${exportBase}${form.id}`}>
                    <Icon name="download" size={16} />
                    Download all answers
                  </a>
                ) : null}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setError(null); setDraft(structuredClone(form)); }} disabled={draft !== null || dealDraft !== null}>
                  Edit
                </button>
                {removing === form.id ? (
                  <>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => void send({ action: "remove", id: form.id }, "Form removed.")} disabled={busy}>
                      Remove it and its answers
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRemoving(null)}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRemoving(form.id)} disabled={draft !== null}>
                    Remove
                  </button>
                )}
              </div>
            </div>
            {open === form.id ? (
              <FormAnswers pdfBase={exportBase.replace("/forms/export?", "/forms/response-pdf?")} form={form} latest={latest} total={total} canReview={dealStages.some(stage => stage.kind === "open")} blocked={draft !== null || dealDraft !== null} existingDeals={knownDeals} existingDealsAvailable={existingDealsAvailable} onReview={response => response.opportunityRef && setDealDraft({ form, response, responseRef: response.opportunityRef })} />
            ) : null}
          </li>
        ))}
      </ul>

      {dealDraft ? <FormResponseDeal form={dealDraft.form} response={dealDraft.response} responseRef={dealDraft.responseRef} stages={dealStages} sid={sid} currency={currency} assignees={dealAssignees} existingDeals={knownDeals} existingDealsAvailable={existingDealsAvailable} onRecorded={rememberOpportunity} onClose={() => setDealDraft(null)} /> : null}

      {error && !draft ? (
        <p className="notice notice-error mt-4" role="alert">
          {error}
        </p>
      ) : null}

      {draft ? (
        <div className="mt-6 rounded-2xl border border-line bg-white p-4 sm:p-6">
          <label className="block">
            <span className="field-label">Name, for you</span>
            <input ref={nameField} className="field mt-2" value={draft.name} maxLength={MAX_FORM_NAME} placeholder="Application for coaching" onChange={(e) => patch({ name: e.target.value })} />
          </label>

          <p className="field-label mt-6">Questions, in order</p>
          <p className="mt-1 text-xs text-ink-soft">
            On a one-choice question, each answer can lead on to a later question or end the form there. The questions an
            answer skips are hidden from that person, not asked and not kept.
          </p>
          <ol className="mt-2 space-y-4">
            {draft.fields.map((field, i) => (
              <li key={field.id} className="rounded-2xl bg-paper p-4 ring-1 ring-line">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
                  <label className="block min-w-0">
                    <span className="field-label">{`Question ${i + 1}`}</span>
                    <input className="field mt-2" value={field.label} maxLength={MAX_LABEL} placeholder="What would you like help with?" onChange={(e) => setField(i, { label: e.target.value })} />
                  </label>
                  <label className="block">
                    <span className="field-label">Kind</span>
                    <select
                      className="field mt-2"
                      value={field.type}
                      onChange={(e) => {
                        const type = e.target.value as FieldType;
                        const fresh = () => ({ id: piece(), label: "", outcome: "", ...(scoredDraft ? { points: 0 } : {}) });
                        setField(i, { type, options: hasOptions(type) ? (field.options.length >= 2 ? field.options : [fresh(), fresh()]) : [] });
                      }}
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t.type} value={t.type}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="mt-2 text-xs text-ink-soft">{FIELD_TYPES.find((t) => t.type === field.type)?.hint}</p>
                {hasOptions(field.type) ? (
                  <div className="mt-3 space-y-2">
                    {field.options.map((option, k) => (
                      <div key={option.id} className="flex flex-wrap items-center gap-2">
                        {/* A visible name of its own, not a placeholder that goes when typing starts (487 [IT4], item 4). */}
                        {/* The whole line on a phone, so its name and field are never squeezed by the controls beside them. */}
                        <label className="flex min-w-0 basis-full items-center gap-2 sm:basis-0 sm:flex-1">
                          <span className="shrink-0 text-sm text-ink-soft">{`Option ${k + 1}`}</span>
                          <input
                            className="field min-w-0 flex-1"
                            value={option.label}
                            maxLength={MAX_OPTION}
                            onChange={(e) => setField(i, { options: field.options.map((o, m) => (m === k ? { ...o, label: e.target.value } : o)) })}
                          />
                        </label>
                        {scoredDraft ? (
                          <>
                            <label className="flex items-center gap-2 text-sm text-ink-soft">
                              Points
                              <input
                                type="number"
                                inputMode="numeric"
                                className="field w-20"
                                aria-label={`Points for option ${k + 1}`}
                                min={0}
                                max={MAX_POINTS}
                                step={1}
                                value={option.points ?? 0}
                                onChange={(e) => setField(i, { options: field.options.map((o, m) => (m === k ? { ...o, points: numberIn(e.target.value, MAX_POINTS) } : o)) })}
                              />
                            </label>
                            {draft.categories?.length ? (
                              <label className="flex min-w-0 max-w-full items-center gap-2 text-sm text-ink-soft">
                                Category
                                <select
                                  className="field w-auto min-w-0 max-w-full flex-1"
                                  aria-label={`Category of option ${k + 1}`}
                                  value={option.category ?? ""}
                                  onChange={(e) => setField(i, { options: field.options.map((o, m) => (m === k ? { ...o, category: e.target.value } : o)) })}
                                >
                                  <option value="">In no category</option>
                                  {draft.categories.map((c, n) => (
                                    <option key={c.id} value={c.id}>
                                      {c.name || `Category ${n + 1}`}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ) : null}
                          </>
                        ) : draft.outcomes.length ? (
                          <label className="flex min-w-0 max-w-full items-center gap-2 text-sm text-ink-soft">
                            Result
                            <select
                              className="field w-auto min-w-0 max-w-full flex-1"
                              aria-label={`Result option ${k + 1} points at`}
                              value={option.outcome}
                              onChange={(e) => setField(i, { options: field.options.map((o, m) => (m === k ? { ...o, outcome: e.target.value } : o)) })}
                            >
                              <option value="">Points at no result</option>
                              {draft.outcomes.map((o, n) => (
                                <option key={o.id} value={o.id}>
                                  {o.title || `Result ${n + 1}`}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        {field.type === "choice" ? (
                          <label className="flex min-w-0 max-w-full items-center gap-2 text-sm text-ink-soft">
                            Next
                            <select
                              className="field w-auto min-w-0 max-w-full flex-1"
                              aria-label={`Next, after option ${k + 1}`}
                              value={option.next ?? ""}
                              onChange={(e) => setField(i, { options: field.options.map((o, m) => (m === k ? { ...o, next: e.target.value } : o)) })}
                            >
                              <option value="">Then the next question</option>
                              {draft.fields.slice(i + 2).map((f, n) => (
                                <option key={f.id} value={f.id}>
                                  {`Then skip to question ${i + 3 + n}${f.label ? `: ${f.label.slice(0, 40)}` : ""}`}
                                </option>
                              ))}
                              <option value={END}>{scoredDraft ? "Then end, with the result for their score" : draft.outcomes.length ? "Then end, with its result" : "Then end the form"}</option>
                            </select>
                          </label>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          aria-label={`Remove option ${k + 1}`}
                          disabled={field.options.length <= 2}
                          onClick={() => setField(i, { options: field.options.filter((_, m) => m !== k) })}
                        >
                          <Icon name="minus" size={16} />
                        </button>
                      </div>
                    ))}
                    {field.options.length < MAX_OPTIONS ? (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setField(i, { options: [...field.options, { id: piece(), label: "", outcome: "", ...(scoredDraft ? { points: 0 } : {}) }] })}>
                        <Icon name="plus" size={16} />
                        Add an option
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-ink">
                    <input type="checkbox" checked={field.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                    Required
                  </label>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => moveField(i, -1)} disabled={i === 0} aria-label={`Move question ${i + 1} up`}>
                    Up
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => moveField(i, 1)} disabled={i === draft.fields.length - 1} aria-label={`Move question ${i + 1} down`}>
                    Down
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => patch({ fields: draft.fields.filter((_, j) => j !== i) })} disabled={draft.fields.length <= 1}>
                    Remove question
                  </button>
                </div>
              </li>
            ))}
          </ol>
          {draft.fields.length < MAX_FIELDS ? (
            <button type="button" className="btn btn-secondary mt-3" onClick={() => patch({ fields: [...draft.fields, { id: piece(), type: "short", label: "", required: false, options: [] }] })}>
              <Icon name="plus" size={18} />
              Add a question
            </button>
          ) : null}

          <p className="field-label mt-8">Results, for a quiz (optional)</p>
          <fieldset className="mt-2">
            <legend className="text-sm font-semibold text-ink">How a result is chosen</legend>
            <label className="mt-2 flex min-h-11 items-start gap-3 text-sm text-ink">
              <input type="radio" className="mt-1" name="form-scoring" checked={!scoredDraft} onChange={() => setScoring(false)} />
              <span>
                By the answers that point at it
                <span className="block text-ink-soft">Each option of a choice can point at a result. A person sees the result the most of their answers point at, the first in this list on a tie.</span>
              </span>
            </label>
            <label className="flex min-h-11 items-start gap-3 text-sm text-ink">
              <input type="radio" className="mt-1" name="form-scoring" checked={scoredDraft} onChange={() => setScoring(true)} />
              <span>
                By score
                <span className="block text-ink-soft">{`Each option of a choice carries 0 to ${MAX_POINTS} points. A person's total is the sum of the options they chose, and they see the result whose range holds it, with their score.`}</span>
              </span>
            </label>
          </fieldset>
          <p className="mt-2 text-sm text-ink-soft">Leave the results empty for a form or a survey.</p>
          {scoredDraft ? <QuizCategories categories={draft.categories ?? []} onChange={(categories) => patch({ categories, fields: draft.fields.map((f) => ({ ...f, options: f.options.map((o) => (o.category && !categories.some((c) => c.id === o.category) ? { ...o, category: "" } : o)) })) })} /> : null}
          <ol className="mt-3 space-y-3">
            {draft.outcomes.map((outcome, i) => (
              <li key={outcome.id} className="rounded-2xl bg-paper p-4 ring-1 ring-line">
                <label className="block">
                  <span className="field-label">{`Result ${i + 1}`}</span>
                  <input className="field mt-2" value={outcome.title} maxLength={MAX_OUTCOME_TITLE} placeholder="You are just starting out" onChange={(e) => setOutcome(i, { title: e.target.value })} />
                </label>
                {scoredDraft ? (
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:max-w-xs">
                    <label className="block">
                      <span className="field-label">Lowest total</span>
                      <input type="number" inputMode="numeric" className="field mt-2" min={0} max={MAX_SCORE} step={1} value={outcome.min ?? 0} onChange={(e) => setOutcome(i, { min: numberIn(e.target.value, MAX_SCORE) })} />
                    </label>
                    <label className="block">
                      <span className="field-label">Highest total</span>
                      <input type="number" inputMode="numeric" className="field mt-2" min={0} max={MAX_SCORE} step={1} value={outcome.max ?? 0} onChange={(e) => setOutcome(i, { max: numberIn(e.target.value, MAX_SCORE) })} />
                    </label>
                  </div>
                ) : null}
                <label className="mt-3 block">
                  <span className="field-label">What it says (optional)</span>
                  <textarea className="field mt-2" rows={3} value={outcome.body} maxLength={MAX_OUTCOME_BODY} onChange={(e) => setOutcome(i, { body: e.target.value })} />
                </label>
                <label className="mt-3 block">
                  <span className="field-label">A product of yours to suggest (optional)</span>
                  <select className="field mt-2" value={outcome.product} onChange={(e) => setOutcome(i, { product: e.target.value })}>
                    <option value="">None</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm mt-3"
                  onClick={() =>
                    patch({
                      outcomes: draft.outcomes.filter((_, j) => j !== i),
                      fields: draft.fields.map((f) => ({ ...f, options: f.options.map((o) => (o.outcome === outcome.id ? { ...o, outcome: "" } : o)) })),
                    })
                  }
                >
                  Remove result
                </button>
              </li>
            ))}
          </ol>
          {draft.outcomes.length < MAX_OUTCOMES ? (
            <button type="button" className="btn btn-secondary mt-3" onClick={() => patch({ outcomes: [...draft.outcomes, { id: piece(), title: "", body: "", product: "", ...(scoredDraft ? { min: 0, max: 0 } : {}) }] })}>
              <Icon name="plus" size={18} />
              Add a result
            </button>
          ) : null}
          {scoredDraft ? <QuizScoringCheck form={draft} onSpread={spread} /> : null}

          <FormSchedule opensAt={draft.opensAt} closesAt={draft.closesAt} onChange={(next) => setDraft((d) => (d ? { ...withoutSchedule(d), ...next } : d))} />

          <p className="field-label mt-8">After sending</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="field-label">Button (optional)</span>
              <input className="field mt-2" value={draft.button} maxLength={MAX_BUTTON} placeholder="Send" onChange={(e) => patch({ button: e.target.value })} />
            </label>
            <label className="block">
              <span className="field-label">Heading after sending (optional)</span>
              <input className="field mt-2" value={draft.doneHeading} maxLength={MAX_DONE_HEADING} placeholder="Thank you" onChange={(e) => patch({ doneHeading: e.target.value })} />
            </label>
          </div>
          <label className="mt-3 block">
            <span className="field-label">What they read after sending (optional)</span>
            <textarea className="field mt-2" rows={3} value={draft.doneBody} maxLength={MAX_DONE_BODY} placeholder="I read every application myself and answer within two days." onChange={(e) => patch({ doneBody: e.target.value })} />
          </label>
          <p className="mt-2 text-xs text-ink-soft">On a page that is a step of a funnel, a form with no results leads straight on to the next step instead.</p>

          <label className={`mt-6 flex min-h-11 items-start gap-3 text-sm font-semibold text-ink ${hasEmail ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
            <input type="checkbox" className="mt-1" checked={draft.offerList && hasEmail} disabled={!hasEmail} onChange={(e) => patch({ offerList: e.target.checked })} />
            <span>
              Offer to join your email list
              <span className="mt-1 block font-normal text-ink-soft">
                {hasEmail
                  ? "A box under the questions, empty until they check it. Checking it sends them an email with a button, and they join your list only once they press it."
                  : "Needs an email question."}
              </span>
            </span>
          </label>

          {error ? (
            <p className="notice notice-error mt-4" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void send({ form: { ...draft, id: draft.id || undefined } }, draft.id ? "Form saved." : "Form made.")}>
              {busy ? "Saving…" : "Save form"}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setDraft(null); setError(null); }}>
              Cancel
            </button>
          </div>
          <p className="mt-4 text-xs text-ink-soft">Never ask for a card number, a password or anything a stranger could use. Answers are kept for you and nobody else.</p>
        </div>
      ) : null}
    </section>
  );
}

/** A draft without its schedule, so a cleared time is left out rather than kept. */
function withoutSchedule(d: FormDef): FormDef {
  const rest = { ...d };
  delete rest.opensAt;
  delete rest.closesAt;
  return rest;
}

/** Seconds as a datetime-local value in the creator's own time zone, and back. */
const toLocal = (seconds: number | undefined): string => {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};
const fromLocal = (value: string): number | undefined => {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : undefined;
};

/**
 * When the form takes answers (639 [GL7](26)): an optional time it opens and
 * one it closes, in the creator's own time zone. Before and after, the page
 * says so instead of asking, and nothing is taken.
 */
function FormSchedule({ opensAt, closesAt, onChange }: { opensAt?: number; closesAt?: number; onChange: (next: { opensAt?: number; closesAt?: number }) => void }) {
  const backwards = Boolean(opensAt && closesAt && closesAt <= opensAt);
  return (
    <fieldset className="mt-8 min-w-0">
      <legend className="field-label">When it takes answers (optional)</legend>
      <p id="form-schedule-help" className="mt-1 text-sm text-ink-soft">
        In your own time zone. Leave both empty to take answers at any time. Before it opens and after it closes, the page says so instead of asking.
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Opens</span>
          <input type="datetime-local" className="field mt-2" aria-describedby="form-schedule-help" value={toLocal(opensAt)} onChange={(e) => onChange({ ...(fromLocal(e.target.value) ? { opensAt: fromLocal(e.target.value) } : {}), ...(closesAt ? { closesAt } : {}) })} />
        </label>
        <label className="block">
          <span className="field-label">Closes</span>
          <input type="datetime-local" className="field mt-2" aria-describedby={`form-schedule-help${backwards ? " form-schedule-order" : ""}`} aria-invalid={backwards || undefined} value={toLocal(closesAt)} onChange={(e) => onChange({ ...(opensAt ? { opensAt } : {}), ...(fromLocal(e.target.value) ? { closesAt: fromLocal(e.target.value) } : {}) })} />
        </label>
      </div>
      {backwards ? (
        <p id="form-schedule-order" role="alert" className="notice notice-warn mt-2">
          It closes before it opens, so the closing time will not be kept. Choose a closing time after the opening.
        </p>
      ) : null}
    </fieldset>
  );
}
