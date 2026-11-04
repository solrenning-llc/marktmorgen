"use client";

import { useState } from "react";
import { useLeaveGuard } from "@/components/leave-guard";
import { confirmedFormOpportunity, formDealDraft, matchingFormDeals, formDealMatchKey, type FormDealMatch } from "@/lib/form-deal";
import { crmAnswer } from "@/lib/crm-response";
import { fieldPrefix, readMoney, type Currency } from "@/lib/money";
import { MAX_DEAL_CENTS, MAX_DEAL_NOTE, MAX_DEAL_TITLE, readFollowUp, type Stage } from "@/lib/crm-rules";
import type { FormDef, FormResponse } from "@/lib/forms";

export function FormResponseDeal({ form, response, responseRef, stages, sid, currency, assignees, existingDeals, existingDealsAvailable = false, onRecorded, onClose }: { existingDealsAvailable?: boolean; onRecorded?: (deal: FormDealMatch) => void; responseRef: string; existingDeals: FormDealMatch[]; currency: string; assignees: string[]; form: FormDef; response: FormResponse; stages: Stage[]; sid: string; onClose: () => void }) {
  const [draft, setDraft] = useState(() => ({ ...formDealDraft(form, response), stage: stages.find(stage => stage.kind === "open")?.id ?? "", nextAction: "Review form response", value: "", dueDate: "", assignee: "" }));
  const [acknowledgedMatches, setAcknowledgedMatches] = useState("");
  const matches = matchingFormDeals(draft.email, existingDeals);
  const matchKey = formDealMatchKey(draft.email, matches);
  const needsAcknowledgment = matches.length > 0 && acknowledgedMatches !== matchKey;
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(() => existingDeals.some(deal => deal.formResponseRef === responseRef));
  const [alreadyCreated, setAlreadyCreated] = useState(() => existingDeals.some(deal => deal.formResponseRef === responseRef));
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const dealsHref = "/studio/deals" + (sid ? "?store=" + encodeURIComponent(sid) : "");
  useLeaveGuard(!saved);
  async function save(recover = false) {
    if (!existingDealsAvailable || busy || saved || (uncertain && !recover) || needsAcknowledgment || !draft.title.trim() || !draft.stage) return;
    if (draft.email.trim() && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(draft.email.trim())) { setError("Enter a valid contact email or leave it empty."); return; }
    const cents = draft.value.trim() ? readMoney(draft.value, currency as Currency) : 0;
    if (cents === null || cents > MAX_DEAL_CENTS) { setError("Enter a valid estimated value in the store currency, or leave it empty."); return; }
    const follow = readFollowUp(draft);
    if (!follow.ok) { setError(follow.error === "date" ? "Choose a real calendar date." : "Write a next action before setting its date."); return; }
    if (draft.assignee && !assignees.includes(draft.assignee)) { setError("Choose an eligible teammate or leave the opportunity unassigned."); return; }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/store/form-opportunity", { method: "POST", headers: { "Content-Type": "application/json", ...(sid ? { "x-nimbus-store": sid } : {}) }, body: JSON.stringify({ form: form.id, responseRef, deal: { title: draft.title, email: draft.email, note: draft.note, stage: draft.stage, ...follow.value, cents } }) });
      const data = await response.json().catch(() => null);
      if (response.status === 409 && data?.ok === false && data.error === "response_gone" && !data.deal) { setError("This response is no longer available for conversion. Reload Forms before creating an opportunity."); return; }
      const answer = crmAnswer(response.ok, data);
      const recorded = answer.ok ? confirmedFormOpportunity(data.deal, responseRef) : null;
      if (recorded && (data.state === "created" || data.state === "existing")) { setAlreadyCreated(data.state === "existing"); setSaved(true); onRecorded?.(recorded); return; }
      if (answer.ok) { setUncertain(true); setError("Creation could not be confirmed. Check Deals before trying again."); return; }
      if (answer.error === "crm_write_unconfirmed") { setUncertain(true); setError("Creation could not be confirmed and may already have happened. Check Deals before creating another opportunity."); }
      else setError(answer.error === "full" ? "The store has reached its deal limit. Review Deals before adding more." : "The opportunity could not be created. Check your access, the selected stage and the saved CRM data before trying again.");
    } catch { setUncertain(true); setError("Creation could not be confirmed and may already have happened. Check Deals before creating another opportunity."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Create opportunity from form response" className="card mt-6 p-5 sm:p-8">
    <h3 className="text-lg font-semibold">Review this response as an opportunity</h3>
    {!existingDealsAvailable && !saved ? <p className="notice notice-warn mt-3" role="status">Existing opportunities could not be checked. Your draft remains here; reload Forms or review Deals before creating another opportunity.</p> : null}
    {saved ? <p className="notice notice-success mt-4" role="status">{alreadyCreated ? "This response already has an opportunity. Its saved details were kept." : "Opportunity created."} Continue tracking it in Deals.</p> : <fieldset disabled={busy || uncertain || !existingDealsAvailable} className="mt-4 space-y-4">
      <legend className="sr-only">Opportunity details</legend>
      <p className="text-sm text-ink-soft">Review the submitted information before saving. Set an estimate and a dated next action when useful. This does not send email or subscribe anyone to marketing.</p>
      <label className="block"><span className="field-label">Opportunity name</span><input className="field mt-2" maxLength={MAX_DEAL_TITLE} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <label className="block"><span className="field-label">Contact email (optional)</span><input className="field mt-2" type="email" autoComplete="off" maxLength={254} value={draft.email} onChange={event => setDraft({ ...draft, email: event.target.value })} /></label>
      {matches.length ? <div className="notice notice-warn" role="status">
        <p className="font-semibold">{matches.length} existing {matches.length === 1 ? "opportunity uses" : "opportunities use"} this email.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">{matches.slice(0, 5).map(deal => <li key={deal.id}>{deal.title} · {stages.find(stage => stage.id === deal.stage)?.name ?? "Stage unavailable"}</li>)}</ul>
        {matches.length > 5 ? <p className="mt-2 text-sm">{matches.length - 5} more matches are available in Deals.</p> : null}
        <p className="mt-2 text-sm">Check Deals before creating another. These matches come from the CRM data loaded with this page.</p>
        <label className="mt-3 flex min-h-11 items-center gap-2"><input type="checkbox" checked={!needsAcknowledgment} onChange={event => setAcknowledgedMatches(event.target.checked ? matchKey : "")} /><span>I reviewed these opportunities and need a separate one.</span></label>
      </div> : null}
      <label className="block"><span className="field-label">Stage</span><select className="field mt-2" value={draft.stage} onChange={event => setDraft({ ...draft, stage: event.target.value })}>{stages.filter(stage => stage.kind === "open").map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
      <label className="block"><span className="field-label">Estimated value ({fieldPrefix(currency)}, optional)</span><input className="field mt-2" inputMode="decimal" maxLength={16} value={draft.value} onChange={event => setDraft({ ...draft, value: event.target.value })} placeholder="0" /></label>
      <p className="text-xs text-ink-soft">An internal sales estimate, not a charge or recorded revenue. Leave empty if unknown.</p>
      <label className="block"><span className="field-label">Response summary</span><textarea className="field mt-2" rows={6} maxLength={MAX_DEAL_NOTE} value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} /></label>
      {draft.truncated ? <p className="text-xs text-ink-soft">The response exceeds the {MAX_DEAL_NOTE}-character deal note limit. Only its beginning is included here. Keep the relevant details; the original response remains in Forms.</p> : null}
      <label className="block"><span className="field-label">Next action</span><input className="field mt-2" maxLength={200} value={draft.nextAction} onChange={event => setDraft({ ...draft, nextAction: event.target.value })} /></label>
      <label className="block"><span className="field-label">Next action date (optional)</span><input className="field mt-2" type="date" value={draft.dueDate} onChange={event => setDraft({ ...draft, dueDate: event.target.value })} /></label>
      <label className="block"><span className="field-label">Responsible teammate</span><select className="field mt-2" value={draft.assignee} onChange={event => setDraft({ ...draft, assignee: event.target.value })}><option value="">Unassigned</option>{assignees.map(email => <option key={email} value={email}>{email}</option>)}</select></label>
      <p className="text-xs text-ink-soft">Dated actions appear in the CRM follow-up queues. Assignment does not send a notification.</p>
    </fieldset>}
    {error ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}
    <div className="mt-5 flex flex-wrap gap-3">
      {!saved ? <button type="button" className="btn btn-primary" disabled={busy || uncertain || !existingDealsAvailable || needsAcknowledgment || !draft.title.trim() || !draft.stage} onClick={() => void save()} aria-busy={busy}>{busy ? "Creating opportunity…" : "Create opportunity"}</button> : null}
      {uncertain ? <button type="button" className="btn btn-secondary" disabled={busy || !existingDealsAvailable} onClick={() => void save(true)}>Retry this conversion</button> : null}
      <a className="btn btn-secondary" href={dealsHref}>Open Deals</a>
      <button type="button" className="btn btn-secondary" disabled={busy || uncertain} onClick={onClose}>{saved ? "Close" : "Cancel"}</button>
    </div>
  </section>;
}
