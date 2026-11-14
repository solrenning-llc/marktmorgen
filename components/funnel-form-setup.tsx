"use client";

import { handFocusOnAfterRemoval } from "@/lib/focus-when-drawn";
import { MAX_FIELDS, MAX_LABEL } from "@/lib/forms";
import type { FunnelDraftField, FunnelFormDraft } from "@/lib/funnel-form-draft";

export function FunnelFormSetup({ value, onChange }: { value: FunnelFormDraft; onChange: (next: FunnelFormDraft) => void }) {
  function changeFields(fields: FunnelDraftField[]) {
    onChange({ fields, offerList: value.offerList && fields.some(field => field.type === "email") });
  }
  function update(index: number, patch: Partial<FunnelDraftField>) {
    changeFields(value.fields.map((field, at) => at === index ? { ...field, ...patch } : field));
  }
  return <fieldset className="mt-5 rounded-xl border border-line p-3">
    <legend className="px-1 text-sm font-semibold">Form questions</legend>
    <p className="text-xs text-ink-soft">Ask only for information you need. Do not request passwords, payment details or sensitive personal information.</p>
    <ol className="mt-3 space-y-4">
      {value.fields.map((field, index) => <li key={index} className="rounded-lg border border-line p-3">
        <label className="block">
          <span className="field-label">Question {index + 1}</span>
          <input className="field mt-2" maxLength={MAX_LABEL} value={field.label} onChange={event => update(index, { label: event.target.value })} />
        </label>
        <label className="mt-3 block">
          <span className="field-label">Answer type for question {index + 1}</span>
          <select className="field mt-2" value={field.type} onChange={event => update(index, { type: event.target.value as FunnelDraftField["type"] })}>
            <option value="short">Short answer</option><option value="long">Long answer</option><option value="email">Email address</option>
          </select>
        </label>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" checked={field.required} onChange={event => update(index, { required: event.target.checked })} /><span className="text-sm">Answer required for question {index + 1}</span></label>
          <button type="button" className="btn btn-secondary btn-sm" disabled={value.fields.length <= 1} aria-label={"Remove question " + (index + 1)} data-list-remove="funnel-form-question" onClick={() => { changeFields(value.fields.filter((_, at) => at !== index)); handFocusOnAfterRemoval("funnel-form-question", index, value.fields.length, "funnel-form-question-add"); }}>Remove</button>
        </div>
      </li>)}
    </ol>
    <button id="funnel-form-question-add" type="button" className="btn btn-secondary mt-3" disabled={value.fields.length >= MAX_FIELDS} onClick={() => changeFields([...value.fields, { type: "short", label: "", required: false }])}>Add question</button>
    <p className="mt-2 text-xs text-ink-soft">{value.fields.length}/{MAX_FIELDS} questions. Complete each question before creating the funnel.</p>
    <label className="mt-3 flex min-h-11 items-start gap-2"><input className="mt-1" type="checkbox" checked={value.offerList} disabled={!value.fields.some(field => field.type === "email")} onChange={event => onChange({ ...value, offerList: event.target.checked })} /><span className="text-sm">Offer an optional email subscription checkbox</span></label>
    <p className="mt-1 text-xs text-ink-soft">Requires an email question. Visitors choose whether to subscribe and must confirm their email. Submitting answers alone does not subscribe them.</p>
    <p className="mt-3 text-xs text-ink-soft">For quiz results, choices and branching, finish setup in Forms after creating the funnel.</p>
  </fieldset>;
}
