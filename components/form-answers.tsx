"use client";

import { useState } from "react";
import { answerText, isScored, responsesCsv, type FormDef, type FormResponse } from "@/lib/forms";
import { filterFormResponses, NO_CURRENT_FORM_RESULT, type FormOpportunityFilter } from "@/lib/form-response-filter";
import type { FormDealMatch } from "@/lib/form-deal";

type ResponseRow = FormResponse & { opportunityRef?: string };

export function FormAnswers({ form, latest, total, canReview, blocked, existingDeals, existingDealsAvailable = false, onReview, pdfBase = "" }: {
  form: FormDef; latest: ResponseRow[]; total: number; canReview: boolean; blocked: boolean;
  existingDeals: FormDealMatch[]; existingDealsAvailable?: boolean; onReview: (response: ResponseRow) => void;
  /** Where one answer is downloaded as a tagged PDF, the form's id and then the answer's added (639 [GL7](26)); "" for none. */
  pdfBase?: string;
}) {
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState("");
  const [opportunityFilter, setOpportunityFilter] = useState<FormOpportunityFilter>("all");
  const linkedRefs = new Set(existingDeals.flatMap(deal => deal.formResponseRef ? [deal.formResponseRef] : []));
  const activeOpportunity = canReview && existingDealsAvailable ? opportunityFilter : "all";
  const filtered = filterFormResponses(form, latest, query, outcome, { available: canReview && existingDealsAvailable, filter: activeOpportunity, refs: linkedRefs });
  const activeOutcome = outcome === NO_CURRENT_FORM_RESULT || form.outcomes.some(item => item.id === outcome) ? outcome : "";
  const changed = !!query || !!activeOutcome || opportunityFilter !== "all";
  const scored = isScored(form);
  const scoreText = (response: ResponseRow) =>
    typeof response.score !== "number" ? "" : [String(response.score), ...(form.categories ?? []).flatMap(c => typeof response.scores?.[c.id] === "number" ? [`${c.name} ${response.scores[c.id]}`] : [])].join(" · ");
  function download() {
    if (!filtered.length) return;
    const file = new Blob(["\uFEFF", responsesCsv(form, filtered)], { type: "text/csv;charset=utf-8" });
    const address = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = address;
    link.download = "form-" + form.id + "-shown-" + filtered.length + ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(address), 1000);
  }
  return (
    <div className="mt-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block" htmlFor={`form-answer-search-${form.id}`}>
          <span className="field-label">Search loaded answers</span>
          <input id={`form-answer-search-${form.id}`} type="search" className="field mt-2" value={query} maxLength={200} placeholder="Name, email or words in an answer" onChange={event => setQuery(event.target.value)} />
        </label>
        {form.outcomes.length ? (
          <label className="block" htmlFor={`form-answer-result-${form.id}`}>
            <span className="field-label">Quiz result</span>
            <select id={`form-answer-result-${form.id}`} className="field mt-2" value={activeOutcome} onChange={event => setOutcome(event.target.value)}>
              <option value="">All results</option>
              {form.outcomes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
              <option value={NO_CURRENT_FORM_RESULT}>No current result</option>
            </select>
          </label>
        ) : null}
        {canReview ? (
          <label className="block" htmlFor={`form-answer-opportunity-${form.id}`}>
            <span className="field-label">Opportunity link</span>
            <select id={`form-answer-opportunity-${form.id}`} className="field mt-2" value={activeOpportunity} disabled={!existingDealsAvailable} onChange={event => setOpportunityFilter(event.target.value as FormOpportunityFilter)}>
              <option value="all">All loaded answers</option>
              <option value="linked">With linked opportunity</option>
              <option value="unlinked">Without linked opportunity</option>
            </select>
          </label>
        ) : null}
      </div>
      {canReview && !existingDealsAvailable ? <p className="notice notice-warn mt-3" role="status">Opportunity links could not be checked. Their filter and new opportunity creation are paused. Search, quiz filters and exports remain available.</p> : null}
      {canReview && existingDealsAvailable ? <p className="mt-2 text-xs text-ink-soft">Links reflect the opportunities loaded with this page. Other opportunities may share the same contact.</p> : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-soft" role="status">{`Showing ${filtered.length.toLocaleString("en-US")} of ${latest.length.toLocaleString("en-US")} loaded answers.`}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-sm" disabled={!filtered.length} onClick={download}>Download shown answers</button>
          {changed ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQuery(""); setOutcome(""); setOpportunityFilter("all"); }}>Clear filters</button> : null}
        </div>
      </div>
      {!filtered.length ? <p className="mt-3 rounded-xl bg-paper p-3 text-sm text-ink-soft">No loaded answers match this selection. Clear the filters or download all answers from the form card.</p> : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead>
              <tr className="text-ink-soft">
                <th scope="col" className="py-2 pr-4 font-semibold">Sent</th>
                {form.fields.map(field => <th scope="col" key={field.id} className="py-2 pr-4 font-semibold">{field.label}</th>)}
                {scored ? <th scope="col" className="py-2 pr-4 font-semibold">Score</th> : null}
                {form.outcomes.length ? <th scope="col" className="py-2 pr-4 font-semibold">Result</th> : null}
                {canReview ? <th scope="col" className="py-2 pr-4 font-semibold">CRM</th> : null}
                {pdfBase ? <th scope="col" className="py-2 pr-4 font-semibold">PDF</th> : null}
              </tr>
            </thead>
            <tbody>
              {filtered.map((response, index) => (
                <tr key={response.id || `${response.at}-${index}`} className="border-t border-line align-top">
                  <td className="py-2 pr-4 whitespace-nowrap">{new Date(response.at * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  {form.fields.map(field => <td key={field.id} className="max-w-[18rem] py-2 pr-4 break-words">{answerText(field, response.answers[field.id])}</td>)}
                  {scored ? <td className="py-2 pr-4 whitespace-nowrap">{scoreText(response)}</td> : null}
                  {form.outcomes.length ? <td className="py-2 pr-4">{form.outcomes.find(item => item.id === response.outcome)?.title ?? ""}</td> : null}
                  {canReview ? <td className="py-2 pr-4"><button type="button" className="btn btn-secondary btn-sm" disabled={blocked || !existingDealsAvailable || !response.opportunityRef} onClick={() => response.opportunityRef && onReview(response)}>{response.opportunityRef && linkedRefs.has(response.opportunityRef) ? "View opportunity" : "Review as opportunity"}</button></td> : null}
                  {pdfBase ? (
                    <td className="py-2 pr-4">
                      {response.id ? (
                        <a className="btn btn-secondary btn-sm whitespace-nowrap" href={`${pdfBase}${encodeURIComponent(form.id)}&response=${encodeURIComponent(response.id)}`} download>
                          Download as PDF<span className="sr-only">{`: the answer sent ${new Date(response.at * 1000).toLocaleString("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`}</span>
                        </a>
                      ) : (
                        <span className="text-ink-soft">Not available for this older answer</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > latest.length ? <p className="mt-2 text-xs text-ink-soft">{`Only the newest ${latest.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} kept answers are loaded. Search and filters apply to these loaded answers. Download all answers from the form card to include the rest.`}</p> : null}
    </div>
  );
}
