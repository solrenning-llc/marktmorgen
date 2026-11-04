"use client";

import { useLeaveGuard } from "@/components/leave-guard";
import { PIPELINE_ACCESS_REFUSAL } from "@/lib/pipeline-access-rules";
import { dealActionFilter, filterDeals, type DealActionFilter } from "@/lib/crm-deal-filter";
import { dealOrder, orderDeals, dealWorklistCsv, type DealOrder, type DealView } from "@/lib/crm-deal-worklist";
import { DealAgenda } from "@/components/deal-agenda";
import { crmAnswer, type CrmAnswer } from "@/lib/crm-response";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { formatMoney, moneyField, readMoney, type Currency } from "@/lib/money";
import {
  type CrmField,
  type Deal,
  FIELD_TYPES,
  hasChoices,
  type FieldType,
  MAX_CRM_FIELDS,
  MAX_DEAL_NOTE,
  MAX_DEAL_TITLE,
  MAX_FIELD_NAME,
  MAX_PIPELINE_NAME,
  MAX_STAGE_NAME,
  MAX_STAGES,
  type Pipeline,
  type Stage,
  type StageKind,
  boardTotals,
  dealFollowUps,
  firstPipeline,
  newCrmId,
  pipelineNames,
  pipelinesShareName,
  pipelineTotals,
  stageLabel,
  starterStages,
  copyPipeline,
} from "@/lib/crm-rules";

const MESSAGES: Record<string, string> = {
  title: "Give the deal a name.",
  followup: "Write a next action before setting its date. Keep it within 200 characters.",
  date: "Choose a real calendar date.",
  assignee: "Choose someone on this store’s team who can read deals.",
  stage: "That stage is gone. Reload the page.",
  full: "This store has as many deals as it can keep. Remove some that are won or lost.",
  unknown: "That is already gone. Reload the page.",
  fields: "Each field needs a name of its own, and a choice needs at least two options.",
  stages: "Keep at least one open stage, one won and one lost, each with a name.",
  pipelines: "Give the pipeline a name no other pipeline has, and keep at least one open stage, one won and one lost, each with a name.",
  pipeline_limit: "Your store has all the pipelines it can keep now. Remove one to make another.",
  pipeline_last: "A store keeps at least one pipeline.",
  moves: "Choose where the deals of each stage you remove go.",
  crm_conflict: "Somebody else changed your pipelines a moment ago, so nothing was saved. Reload the page and make your change again.",
  deal_conflict: "Somebody else changed this deal a moment ago, so nothing was saved. Reload the page and make your change again.",
  // A refused change by access (639 [GL7](7)): nothing was saved, and the board stays usable.
  pipeline_access: PIPELINE_ACCESS_REFUSAL,
  server_error: "The change could not be confirmed. Check the saved CRM data before trying again.",
  crm_schema_read_unavailable: "The saved CRM configuration could not be checked before this change. Your current work is still here. Try again shortly.",
  crm_deal_read_unavailable: "Saved deals could not be checked before this change. Your current work is still here. Try again shortly.",
  crm_write_unconfirmed: "The change could not be confirmed and may already have happened. Keep a copy of unsaved work, then reload this page and check the saved CRM data before trying again.",
  ...STUDIO_MESSAGES,
};

async function call(body: Record<string, unknown>): Promise<CrmAnswer> {
  try {
    const response = await fetch("/api/store/crm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return crmAnswer(response.ok, await response.json().catch(() => null));
  } catch {
    return crmAnswer(false, null);
  }
}

type DealDraft = { id: string; title: string; email: string; value: string; stage: string; note: string; nextAction: string; dueDate: string; assignee: string };

function draftFromDeal(deal: Deal, currency: string): DealDraft {
  return { id: deal.id, title: deal.title, email: deal.email, value: deal.cents ? moneyField(deal.cents, currency) : "", stage: deal.stage, note: deal.note, nextAction: deal.nextAction ?? "", dueDate: deal.dueDate ?? "", assignee: deal.assignee ?? "" };
}

const KIND_WORDS: Record<StageKind, string> = { open: "Open", won: "Won", lost: "Lost" };

/**
 * A store's deals, stage by stage (lib/crm-rules.ts): what each is worth,
 * who it is with, and a way to move it on. The stages are the store's own,
 * and so are the fields kept about each person, made here too.
 */
type PipelineDraft = { id: string; name: string; stages: Stage[]; isNew: boolean; moves: Record<string, string>; removeTo: string };

/** The stages of every pipeline, grouped, for a choice of stage: a deal can be put in any pipeline. */
function StageOptions({ pipelines, except, names }: { pipelines: readonly Pipeline[]; except?: ReadonlySet<string>; /** Each pipeline's name as the board shows it (pipelineNames). */ names: ReadonlyMap<string, string> }) {
  const shown = pipelines.map(p => ({ ...p, stages: p.stages.filter(s => !except?.has(s.id)) })).filter(p => p.stages.length);
  if (shown.length < 2) return <>{shown.flatMap(p => p.stages).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</>;
  return <>{shown.map(p => <optgroup key={p.id} label={names.get(p.id) ?? p.name}>{p.stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>)}</>;
}

export function DealsBoard({ deals, stages: everyStage, pipelines: savedPipelines, pipelineMax = 1, fields, currency, assignees, today, initialFilter = "all", requestHref, viewOnly, someHidden = false, othersHidden = false }: { deals: Deal[]; stages: Stage[]; /** The store's pipelines (lib/crm-rules.ts); the first holds the board it always had. */ pipelines?: Pipeline[]; /** How many pipelines the store's plan may have. */ pipelineMax?: number; fields: CrmField[]; currency: string; assignees: string[]; today: string; initialFilter?: DealActionFilter; /** The payment requests page, for a role that may send them; a deal with a person links to it, filled in. */ requestHref?: string; /** Pipelines this person may see but not change (639 [GL7](7)): their deals are shown without the controls that change them. */ viewOnly?: string[]; /** Someone who may not see every pipeline (639 [GL7](7)): the store's pipeline count is never said, so it cannot tell how many are hidden. */ someHidden?: boolean; /** The store has pipelines this person does not see, so the one they see is not its last and may be removed. */ othersHidden?: boolean }) {
  const router = useRouter();
  // Someone who may not see any of the store's pipelines (639 [GL7](7)) still adds one of their own and changes
  // the fields, as the server lets them: the board then shows only that.
  const noneSeen = someHidden && savedPipelines !== undefined && savedPipelines.length === 0;
  const pipelines: Pipeline[] = savedPipelines?.length ? savedPipelines : [firstPipeline(everyStage)];
  const [pipelineId, setPipelineId] = useState(pipelines[0].id);
  const pipeline = pipelines.find(p => p.id === pipelineId) ?? pipelines[0];
  // Two pipelines may share a name (lib/crm-rules.ts, pipelineNames): every name on this board tells them apart.
  const names = pipelineNames(pipelines);
  const nameOf = (p: Pick<Pipeline, "id" | "name">) => names.get(p.id) ?? p.name;
  const pipelineCount = noneSeen ? 0 : pipelines.length;
  // The first name two pipelines share, as it is saved, for the sentence that says why one shows a number.
  const shared = pipelinesShareName(pipelines) ? pipelines.find((p, i) => pipelines.findIndex(q => q.name.toLowerCase() === p.name.toLowerCase()) !== i)?.name ?? "" : "";
  // What this person may change (lib/pipeline-access-rules.ts): a pipeline marked view shows its deals and nothing that changes them.
  const readOnly = new Set(viewOnly ?? []);
  const canChange = !readOnly.has(pipeline.id);
  const editable = pipelines.filter(p => !readOnly.has(p.id));
  // This pipeline's stages and deals: what the board, its filters, its agenda and its file show.
  const stages = pipeline.stages;
  const here = new Set(stages.map(s => s.id));
  const pipelineDeals = deals.filter(d => here.has(d.stage));
  const allTotals = pipelines.map(p => pipelineTotals(p, deals));
  const [pipelineDraft, setPipelineDraft] = useState<PipelineDraft | null>(null);
  const money = (cents: number) => formatMoney(cents, currency);
  const [draft, setDraft] = useState<DealDraft | null>(null);
  const dealNameInput = useRef<HTMLInputElement>(null);
  const activeDealId = draft?.id;
  useEffect(() => { if (activeDealId !== undefined) dealNameInput.current?.focus(); }, [activeDealId]);
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [writeUnconfirmed, setWriteUnconfirmed] = useState(false);
  const locked = busy || refreshing;
  const [error, setError] = useState<string | null>(null);
  const [fieldDraft, setFieldDraft] = useState<(CrmField & { optionsText: string })[] | null>(null);
  const [filter, setFilter] = useState<DealActionFilter>(dealActionFilter(initialFilter));
  const [search, setSearch] = useState("");
  const [responsible, setResponsible] = useState("all");
  const [view, setView] = useState<DealView>("board");
  const [order, setOrder] = useState<DealOrder>("current");
  const scopedDeals = filterDeals(pipelineDeals, search, responsible === "all" ? null : responsible === "unassigned" ? "" : responsible.slice(7));
  const responsibleChoices = [...new Set([...assignees, ...deals.flatMap(d => d.assignee ? [d.assignee] : [])])].sort();
  const followUps = dealFollowUps(stages, scopedDeals, today);
  const visibleIds = filter === "all" ? null : new Set(followUps[filter as keyof typeof followUps].map(d => d.id));
  const totals = boardTotals(stages, pipelineDeals);
  const visibleDeals = orderDeals(scopedDeals.filter(d => !visibleIds || visibleIds.has(d.id)), order);
  const columns = boardTotals(stages, visibleDeals);
  const selectionChanged = !!search || responsible !== "all" || filter !== "all" || order !== (view === "agenda" ? "due" : "current");
  const open = totals.filter((t) => t.stage.kind === "open");
  const won = totals.filter((t) => t.stage.kind === "won");

  async function run(body: Record<string, unknown>, done: string, after?: () => void) {
    if (locked || writeUnconfirmed) return;
    setBusy(true);
    setError(null);
    const answer = await call(body);
    setBusy(false);
    if (answer.ok) {
      toast(answer.workflows === "not_checked" ? `${done} The workflow for this stage was not started for this person.` : done);
      after?.();
      startRefresh(() => router.refresh());
      return;
    }
    if (answer.error === "crm_write_unconfirmed") setWriteUnconfirmed(true);
    // Someone who cannot see every pipeline is never told to remove one they cannot see.
    setError(
      answer.error === "pipeline_limit" && someHidden ? "Your store has all the pipelines it can keep now. Ask the store's owner if you need another."
        : answer.error === "deal_conflict" && body.action === "undeal" ? "Somebody else changed this deal a moment ago, so nothing was removed. Reload the page and look at it again."
        : (MESSAGES[answer.error] ?? MESSAGES.server_error),
    );
  }

  function downloadWorklist() {
    if (!visibleDeals.length || locked || writeUnconfirmed) return;
    const csv = dealWorklistCsv(visibleDeals, stages.map(s => ({ ...s, name: stageLabel(pipelines, s) })), { today, currency, query: search, responsible, filter, order, view });
    const address = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = address;
    link.download = "deal-worklist-" + (pipelines.length > 1 ? nameOf(pipeline).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" : "") + today + ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(address), 1000);
  }

  function saveDeal() {
    if (!draft || locked || writeUnconfirmed) return;
    const cents = draft.value.trim() ? readMoney(draft.value, currency as Currency) : 0;
    if (cents === null) {
      setError("Type what it is worth as a number, like 1500 or 1500.50.");
      return;
    }
    void run(
      { action: "deal", deal: { id: draft.id || undefined, title: draft.title, email: draft.email, cents, stage: draft.stage, note: draft.note, nextAction: draft.nextAction, dueDate: draft.dueDate, assignee: draft.assignee } },
      draft.id ? "Deal saved." : "Deal added.",
      () => setDraft(null),
    );
  }

  const firstOpen = stages.find((s) => s.kind === "open")?.id ?? stages[0]?.id ?? "";
  const original = draft?.id ? deals.find(deal => deal.id === draft.id) : null;
  const initialDeal = original ? draftFromDeal(original, currency) : { id: "", title: "", email: "", value: "", stage: firstOpen, note: "", nextAction: "", dueDate: "", assignee: "" };
  const initialFields = fields.map(field => ({ ...field, optionsText: field.options.join(", ") }));
  const pipelineDirty = pipelineDraft !== null && (pipelineDraft.isNew || pipelineDraft.name !== pipeline.name || JSON.stringify(pipelineDraft.stages) !== JSON.stringify(pipeline.stages));
  const dirty = (draft !== null && JSON.stringify(draft) !== JSON.stringify(initialDeal)) || pipelineDirty || (fieldDraft !== null && JSON.stringify(fieldDraft) !== JSON.stringify(initialFields));
  useLeaveGuard(dirty);
  const editing = draft !== null || pipelineDraft !== null || fieldDraft !== null;
  // How many deals each saved stage holds now: a stage removed with deals in it asks where they go.
  const dealsIn = (stageId: string) => deals.filter(d => d.stage === stageId).length;

  function savePipeline() {
    if (!pipelineDraft || locked || writeUnconfirmed) return;
    const kept = new Set(pipelineDraft.stages.map(s => s.id));
    const gone = pipelineDraft.isNew ? [] : pipeline.stages.filter(s => !kept.has(s.id) && dealsIn(s.id) > 0);
    if (gone.some(s => !pipelineDraft.moves[s.id])) {
      setError(MESSAGES.moves);
      return;
    }
    const moves = Object.fromEntries(gone.map(s => [s.id, pipelineDraft.moves[s.id]]));
    void run({ action: "pipeline", pipeline: { id: pipelineDraft.id, name: pipelineDraft.name, stages: pipelineDraft.stages }, moves }, pipelineDraft.isNew ? "Pipeline added." : gone.length ? "Pipeline saved, and its deals moved." : "Pipeline saved.", () => { if (pipelineDraft.isNew) setPipelineId(pipelineDraft.id); setPipelineDraft(null); });
  }

  function removePipeline() {
    if (!pipelineDraft || pipelineDraft.isNew || locked || writeUnconfirmed) return;
    const holding = pipelineDeals.length;
    if (holding && !pipelineDraft.removeTo) {
      setError(MESSAGES.moves);
      return;
    }
    void run({ action: "unpipeline", id: pipeline.id, moveTo: pipelineDraft.removeTo }, holding ? `Pipeline removed; its ${holding === 1 ? "deal was" : `${holding} deals were`} moved.` : "Pipeline removed.", () => { setPipelineId(pipelines.find(p => p.id !== pipeline.id)?.id ?? pipelines[0].id); setPipelineDraft(null); });
  }

  const moveStage = (from: number, to: number) => {
    if (!pipelineDraft || to < 0 || to >= pipelineDraft.stages.length) return;
    const next = [...pipelineDraft.stages];
    const [one] = next.splice(from, 1);
    next.splice(to, 0, one);
    setPipelineDraft({ ...pipelineDraft, stages: next });
  };

  return (
    <div className="space-y-8">
      {locked ? <p className="notice" role="status">{refreshing ? "Loading the latest CRM data…" : "Saving your CRM change. Editing is paused until this finishes."}</p> : null}
      {writeUnconfirmed ? <p className="notice notice-warn" role="status">{MESSAGES.crm_write_unconfirmed} CRM changes are paused on this page until you reload.</p> : null}
      {editing ? <p className="notice notice-warn" role="status">Save or cancel the open editor before starting another edit, moving a deal or removing one.</p> : null}
      <section aria-labelledby="deals-title" className="card min-w-0 p-5 sm:p-8">
        {noneSeen ? (
          <>
            <h2 id="deals-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
              Deals
            </h2>
            <p className="notice notice-info mt-3">You have no pipelines to see in this store. Ask the store&apos;s owner if you need to see one. You can still add a pipeline of your own and change the fields below.</p>
            {pipelineCount < pipelineMax && !pipelineDraft ? (
              <button type="button" className="btn btn-secondary btn-sm mt-4" disabled={locked || editing || writeUnconfirmed} onClick={() => { setError(null); setPipelineDraft({ id: newCrmId(), name: "", stages: starterStages(), isNew: true, moves: {}, removeTo: "" }); }}>
                <Icon name="plus" size={16} />
                New pipeline
              </button>
            ) : pipelineCount >= pipelineMax ? <p className="mt-3 text-sm text-ink-soft">Your store has no room for another pipeline.</p> : null}
          </>
        ) : (
        <>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-2xl">
            <h2 id="deals-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
              Deals
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              {`People you are talking to about something sold outside a checkout: a coaching package, a custom project.${pipelines.length > 1 ? ` In ${nameOf(pipeline)}:` : ""} ${open.reduce((n, t) => n + t.count, 0)} open, worth ${money(open.reduce((n, t) => n + t.cents, 0))}; won so far, ${money(won.reduce((n, t) => n + t.cents, 0))}.`}
            </p>
          </div>
          {draft === null && canChange ? (
            <button type="button" className="btn btn-primary" disabled={locked || editing || writeUnconfirmed} onClick={() => { setError(null); setDraft({ id: "", title: "", email: "", value: "", stage: firstOpen, note: "", nextAction: "", dueDate: "", assignee: "" }); }}>
              <Icon name="plus" size={18} />
              New deal
            </button>
          ) : !canChange ? (
            // Said where "New deal" would be, so nobody wonders where it went (639 [GL7](7)).
            <p className="max-w-xs text-sm text-ink-soft">You can see this pipeline but not change it. Ask the store&apos;s owner to change your access.</p>
          ) : null}
        </div>

        <div className="mt-5" role="group" aria-label="Pipelines">
          <div className="flex flex-wrap items-center gap-2">
            {allTotals.map(t => (
              <button key={t.pipeline.id} type="button" aria-pressed={t.pipeline.id === pipeline.id} disabled={editing && t.pipeline.id !== pipeline.id} className={`btn btn-sm ${t.pipeline.id === pipeline.id ? "btn-primary" : "btn-secondary"}`} onClick={() => { setPipelineId(t.pipeline.id); setError(null); }}>
                {nameOf(t.pipeline)}
                <span className="tabular-nums opacity-80">{` · ${t.open.count} open`}</span>
                {readOnly.has(t.pipeline.id) ? <span className="opacity-80"> · view only</span> : null}
              </button>
            ))}
            {pipelineCount < pipelineMax ? (
              <button type="button" className="btn btn-ghost btn-sm" disabled={locked || editing || writeUnconfirmed} onClick={() => { setError(null); setPipelineDraft({ id: newCrmId(), name: "", stages: starterStages(), isNew: true, moves: {}, removeTo: "" }); }}>
                <Icon name="plus" size={16} />
                New pipeline
              </button>
            ) : null}
            {pipelines.length < pipelineMax && canChange ? (
              /* 639 [GL7](8): the same stages under a new name, none of its deals; opened to read and save, nothing saved yet. */
              <button type="button" className="btn btn-ghost btn-sm" disabled={locked || editing || writeUnconfirmed} onClick={() => { setError(null); const copy = copyPipeline(pipeline, pipelines); setPipelineDraft({ ...copy, isNew: true, moves: {}, removeTo: "" }); }}>
                <Icon name="plus" size={16} />
                {`Duplicate “${nameOf(pipeline)}”`}
              </button>
            ) : null}
          </div>
          {shared ? <p className="mt-2 text-sm text-ink-soft">{`Some of these pipelines share a name, so each one made later shows a number after it, such as “${shared} (2)”. Rename one to tell them apart.`}</p> : null}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <caption className="sr-only">What each pipeline&apos;s deals add up to</caption>
              <thead><tr className="text-ink-soft">{["Pipeline", "Open", "Won", "Lost"].map(label => <th key={label} scope="col" className="py-2 pr-4 font-semibold">{label}</th>)}</tr></thead>
              <tbody>{allTotals.map(t => (
                <tr key={t.pipeline.id} className="border-t border-line">
                  <th scope="row" className="py-2 pr-4 font-semibold text-ink [overflow-wrap:anywhere]">{nameOf(t.pipeline)}</th>
                  {(["open", "won", "lost"] as const).map(k => <td key={k} className="py-2 pr-4 tabular-nums text-ink-soft">{`${t[k].count} · ${money(t[k].cents)}`}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-mute">{`Each total adds up the values recorded on its deals, in ${currency.toUpperCase()}. Nothing is weighted or forecast. ${someHidden ? (pipelines.length < pipelineMax ? "Your store can add another pipeline." : "Your store has no room for another pipeline.") : `You have ${pipelines.length} of the ${pipelineMax} ${pipelineMax === 1 ? "pipeline" : "pipelines"} your store can keep.`}`}</p>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="block"><span className="field-label">Find a deal</span><input type="search" className="field mt-2" maxLength={80} value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, email, next action or note" /></label><label className="block"><span className="field-label">Responsible teammate</span><select className="field mt-2" value={responsible} onChange={e => setResponsible(e.target.value)}><option value="all">Everyone</option><option value="unassigned">Unassigned</option>{responsibleChoices.map(email => <option key={email} value={"person:" + email}>{email}{assignees.includes(email) ? "" : " (no longer eligible)"}</option>)}</select></label></div>
        <p className="mt-2 text-xs text-ink-mute">{`The summary above includes all of ${pipelines.length > 1 ? `this pipeline's` : "your"} deals. Action counts and columns follow your search and teammate selection.`}</p>
        <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Filter deals by next action">
          {([{ key: "all", label: "All deals" }, { key: "overdue", label: `Overdue (${followUps.overdue.length})` }, { key: "today", label: `Due today (${followUps.today.length})` }, { key: "upcoming", label: `Upcoming (${followUps.upcoming.length})` }, { key: "unplanned", label: `No dated action (${followUps.unplanned.length})` }]).map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} className={`btn btn-sm ${filter === item.key ? "btn-primary" : "btn-secondary"}`} onClick={() => setFilter(dealActionFilter(item.key))}>{item.label}</button>)}
        </div>
        <p className="mt-2 text-xs text-ink-mute">Dates use the calendar day shown here, {today} (UTC). Won and lost deals are left out of action filters. Nothing is sent automatically.</p>

        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Deal view">
          <button type="button" className={`btn btn-sm ${view === "board" ? "btn-primary" : "btn-secondary"}`} aria-pressed={view === "board"} onClick={() => setView("board")}>Board</button>
          <button type="button" className={`btn btn-sm ${view === "agenda" ? "btn-primary" : "btn-secondary"}`} aria-pressed={view === "agenda"} onClick={() => { setView("agenda"); if (order === "current") setOrder("due"); }}>Agenda</button>
        </div>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
          <label className="block">
            <span className="field-label">{view === "agenda" ? "Order across all stages" : "Order within each stage"}</span>
            <select className="field mt-2" value={order} onChange={event => setOrder(dealOrder(event.target.value))}>
              <option value="current">Current order</option>
              <option value="due">Earliest action date</option>
              <option value="value">Highest recorded value</option>
              <option value="oldest">Longest without an update</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary btn-sm" disabled={!visibleDeals.length || locked || writeUnconfirmed} onClick={downloadWorklist}>Download selected deals</button>
            {selectionChanged ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSearch(""); setResponsible("all"); setFilter("all"); setOrder(view === "agenda" ? "due" : "current"); }}>Clear selection</button> : null}
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-mute" role="status">{`Showing ${visibleDeals.length.toLocaleString("en-US")} of ${deals.length.toLocaleString("en-US")} loaded deals. The CSV follows these filters and the ${view === "agenda" ? "order across all stages" : "order within each stage"}. Recorded values are opportunity estimates, not confirmed revenue.`}</p>

        {draft ? (
          <fieldset disabled={locked} aria-busy={locked} className="min-w-0 mt-6 rounded-2xl border border-line bg-white p-4 sm:p-6">
            <legend className="sr-only">Deal details</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="field-label">What it is</span>
                <input ref={dealNameInput} className="field mt-2" maxLength={MAX_DEAL_TITLE} value={draft.title} placeholder="Six coaching sessions for Dana" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label className="block">
                <span className="field-label">Their email (optional)</span>
                <input className="field mt-2" type="email" autoComplete="off" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
              </label>
              <label className="block">
                <span className="field-label">{`What it is worth, in ${currency.toUpperCase()} (optional)`}</span>
                <input className="field mt-2" inputMode="decimal" value={draft.value} placeholder="1500" onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
              </label>
              <label className="block">
                <span className="field-label">{pipelines.length > 1 ? "Pipeline and stage" : "Stage"}</span>
                <select className="field mt-2" value={draft.stage} onChange={(e) => setDraft({ ...draft, stage: e.target.value })}>
                  <StageOptions pipelines={editable} names={names} />
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="field-label">Next action (optional)</span>
                <input className="field mt-2" maxLength={200} value={draft.nextAction} placeholder="Follow up on the proposal" onChange={e => setDraft({ ...draft, nextAction: e.target.value })} />
              </label>
              <label className="block">
                <span className="field-label">Action date (optional, UTC calendar date)</span>
                <input className="field mt-2" type="date" value={draft.dueDate} onChange={e => setDraft({ ...draft, dueDate: e.target.value })} />
              </label>
              <label className="block">
                <span className="field-label">Responsible teammate (optional)</span>
                <select className="field mt-2" value={draft.assignee} onChange={e => setDraft({ ...draft, assignee: e.target.value })}>
                  <option value="">Unassigned</option>
                  {draft.assignee && !assignees.includes(draft.assignee) ? <option value={draft.assignee}>{draft.assignee} (no longer eligible)</option> : null}
                  {assignees.map(email => <option key={email} value={email}>{email}</option>)}
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="field-label">A note (optional)</span>
                <textarea className="field mt-2" rows={3} maxLength={MAX_DEAL_NOTE} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
              </label>
            </div>
            {error ? (
              <p className="notice notice-error mt-4" role="alert">
                {error}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className="btn btn-primary" disabled={locked || writeUnconfirmed} onClick={saveDeal}>
                {busy ? "Saving…" : "Save deal"}
              </button>
              <button type="button" className="btn btn-secondary" disabled={locked} onClick={() => { setDraft(null); setError(null); }}>
                Cancel
              </button>
            </div>
          </fieldset>
        ) : null}

        {/* An empty board says what it is for and how to start (487 [IT4], pattern 5). */}
        {pipelineDeals.length === 0 && draft === null ? (
          <p className="mt-6 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink-soft">
            {canChange ? <>No deals yet. When someone asks about something you sell outside a checkout, press &ldquo;New deal&rdquo; and move it across the stages as the talk goes on.</> : "No deals in this pipeline yet. You can see it but not change it."}
          </p>
        ) : null}
        {view === "agenda" ? <DealAgenda deals={visibleDeals} stages={stages} currency={currency} today={today} disabled={locked || editing || writeUnconfirmed} onEdit={canChange ? deal => { setError(null); setDraft(draftFromDeal(deal, currency)); } : undefined} /> : (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {columns.map(({ stage, count, cents }) => (
            <section key={stage.id} aria-label={stage.name} className="min-w-0 rounded-2xl bg-paper p-4 ring-1 ring-line">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold text-ink">
                  {stage.name}
                  {stage.kind !== "open" && stage.name.toLowerCase() !== KIND_WORDS[stage.kind].toLowerCase() ? <span className="tag ml-2">{KIND_WORDS[stage.kind]}</span> : null}
                </h3>
                <p className="text-sm tabular-nums text-ink-soft">{`${count} · ${money(cents)}`}</p>
              </div>
              {(visibleIds || search.trim() || responsible !== "all") && !scopedDeals.some(d => d.stage === stage.id && (!visibleIds || visibleIds.has(d.id))) ? <p className="mt-3 text-sm text-ink-mute">No deals match this filter.</p> : null}
              <ul className="mt-3 space-y-3">
                {visibleDeals
                  .filter((d) => d.stage === stage.id)
                  .map((deal) => (
                    <li key={deal.id} className="rounded-xl bg-white p-3 text-sm ring-1 ring-line">
                      <p className="font-semibold text-ink [overflow-wrap:anywhere]">{deal.title}</p>
                      <p className="mt-1 tabular-nums text-ink-soft">{deal.cents ? money(deal.cents) : "No amount yet"}</p>
                      {deal.email ? (
                        <p className="mt-1 text-ink-soft [overflow-wrap:anywhere]">
                          {deal.email}
                        </p>
                      ) : null}
                      {deal.nextAction ? <p className="mt-2 font-semibold text-ink">Next: {deal.nextAction}</p> : null}
                      {deal.dueDate ? <p className={`mt-1 text-xs ${followUps.overdue.some(d => d.id === deal.id) ? "font-semibold text-danger" : "text-ink-soft"}`}>Due {deal.dueDate}</p> : null}
                      {deal.assignee ? <p className="mt-1 text-xs text-ink-soft [overflow-wrap:anywhere]">Responsible: {deal.assignee}</p> : null}
                      {deal.note ? <p className="mt-2 whitespace-pre-line text-ink-soft [overflow-wrap:anywhere]">{deal.note}</p> : null}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {canChange ? (
                          <>
                        <label className="min-w-0 flex-1">
                          <span className="sr-only">{pipelines.length > 1 ? `Move ${deal.title} to a stage or another pipeline` : `Move ${deal.title}`}</span>
                          <select
                            className="field"
                            value={deal.stage}
                            disabled={locked || editing || writeUnconfirmed}
                            onChange={(e) => void run({ action: "deal", deal: { ...deal, stage: e.target.value } }, here.has(e.target.value) ? "Deal moved." : `Deal moved to ${(() => { const to = pipelines.find(p => p.stages.some(st => st.id === e.target.value)); return to ? nameOf(to) : "another pipeline"; })()}.`)}
                          >
                            <StageOptions pipelines={editable} names={names} />
                          </select>
                        </label>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={locked || editing || writeUnconfirmed}
                          onClick={() => { setError(null); setDraft(draftFromDeal(deal, currency)); }}
                        >
                          Edit
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" disabled={locked || editing || writeUnconfirmed} onClick={() => void run({ action: "undeal", id: deal.id }, "Deal removed.")} aria-label={`Remove ${deal.title}`}>
                          <Icon name="minus" size={16} />
                        </button>
                          </>
                        ) : null}
                        {requestHref && deal.email ? (
                          <a
                            className="btn btn-secondary btn-sm"
                            href={`${requestHref}${requestHref.includes("?") ? "&" : "?"}${new URLSearchParams({ email: deal.email, for: deal.title, ...(deal.cents ? { amount: moneyField(deal.cents, currency) } : {}) }).toString()}`}
                          >
                            <Icon name="receipt" size={16} /> Request payment
                          </a>
                        ) : null}
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
        )}
        </>
        )}
        {error && !draft && !pipelineDraft && !fieldDraft ? (
          <p className="notice notice-error mt-4" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-6">
          {pipelineDraft ? (
            <fieldset disabled={locked} aria-busy={locked} className="min-w-0 rounded-2xl border border-line bg-white p-4 sm:p-6">
              <legend className="sr-only">{pipelineDraft.isNew ? "New pipeline" : "Pipeline and its stages"}</legend>
              <label className="block">
                <span className="field-label">{pipelineDraft.isNew ? "Name of the new pipeline" : "Pipeline name"}</span>
                <input className="field mt-2" maxLength={MAX_PIPELINE_NAME} value={pipelineDraft.name} placeholder="Partnerships" onChange={e => setPipelineDraft({ ...pipelineDraft, name: e.target.value })} />
              </label>
              <p className="mt-4 font-semibold text-ink">Stages, in order</p>
              <ol className="mt-3 space-y-3">
                {pipelineDraft.stages.map((stage, i) => (
                  <li key={stage.id} className="flex flex-wrap items-center gap-2">
                    {/* A visible name of its own (487 [IT4], item 4). */}
                    {/* The whole line on a phone, so its name and field are never squeezed by the controls beside them. */}
                    <label className="flex min-w-0 basis-full items-center gap-2 sm:basis-0 sm:flex-1">
                      <span className="shrink-0 text-sm text-ink-soft">{`Stage ${i + 1}`}</span>
                      <input className="field min-w-0 flex-1" maxLength={MAX_STAGE_NAME} value={stage.name} onChange={(e) => setPipelineDraft({ ...pipelineDraft, stages: pipelineDraft.stages.map((s, j) => (j === i ? { ...s, name: e.target.value } : s)) })} />
                    </label>
                    <label className="flex items-center gap-2 text-sm text-ink-soft">
                      Counts as
                      <select className="field w-auto" aria-label={`Counts as, for stage ${i + 1}`} value={stage.kind} onChange={(e) => setPipelineDraft({ ...pipelineDraft, stages: pipelineDraft.stages.map((s, j) => (j === i ? { ...s, kind: e.target.value as StageKind } : s)) })}>
                        <option value="open">Open</option>
                        <option value="won">Won</option>
                        <option value="lost">Lost</option>
                      </select>
                    </label>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={i === 0} onClick={() => moveStage(i, i - 1)} aria-label={`Move stage ${i + 1} up`}>Up</button>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={i === pipelineDraft.stages.length - 1} onClick={() => moveStage(i, i + 1)} aria-label={`Move stage ${i + 1} down`}>Down</button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPipelineDraft({ ...pipelineDraft, stages: pipelineDraft.stages.filter((_, j) => j !== i) })} aria-label={`Remove stage ${i + 1}`}>
                      <Icon name="minus" size={16} />
                    </button>
                  </li>
                ))}
              </ol>
              {pipelineDraft.stages.length < MAX_STAGES ? (
                <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => setPipelineDraft({ ...pipelineDraft, stages: [...pipelineDraft.stages, { id: newCrmId(), name: "", kind: "open" }] })}>
                  <Icon name="plus" size={16} />
                  Add a stage
                </button>
              ) : null}
              <p className="mt-3 text-xs text-ink-soft">{`Up to ${MAX_STAGES} stages, with at least one open, one won and one lost.`}</p>
              {(() => {
                if (pipelineDraft.isNew) return null;
                const kept = new Set(pipelineDraft.stages.map(s => s.id));
                const gone = pipeline.stages.filter(s => !kept.has(s.id) && dealsIn(s.id) > 0);
                if (!gone.length) return null;
                // Where they can go: a stage kept in this pipeline (named), or any stage of another one.
                const targets: Pipeline[] = [{ ...pipeline, stages: pipelineDraft.stages.filter(s => s.name.trim()) }, ...editable.filter(p => p.id !== pipeline.id)];
                return (
                  <div className="mt-4 space-y-3 rounded-xl bg-paper p-4 ring-1 ring-line">
                    <p className="text-sm font-semibold text-ink">The stages you removed still hold deals. Choose where each one&apos;s deals go; none is deleted.</p>
                    {gone.map(s => (
                      <label key={s.id} className="block">
                        <span className="field-label">{`${s.name}: ${dealsIn(s.id)} ${dealsIn(s.id) === 1 ? "deal" : "deals"} go to`}</span>
                        <select className="field mt-2" value={pipelineDraft.moves[s.id] ?? ""} onChange={e => setPipelineDraft({ ...pipelineDraft, moves: { ...pipelineDraft.moves, [s.id]: e.target.value } })}>
                          <option value="">Choose a stage</option>
                          <StageOptions pipelines={targets} names={names} />
                        </select>
                      </label>
                    ))}
                    <p className="text-xs text-ink-soft">Moving them this way starts no workflow.</p>
                  </div>
                );
              })()}
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" className="btn btn-primary" disabled={locked || writeUnconfirmed} onClick={savePipeline}>
                  {pipelineDraft.isNew ? "Add pipeline" : "Save pipeline"}
                </button>
                <button type="button" className="btn btn-secondary" disabled={locked} onClick={() => { setPipelineDraft(null); setError(null); }}>
                  Cancel
                </button>
              </div>
              {/* Remove is offered on the only pipeline someone sees when the store has others they do not see (it is
                  then not the store's last one, which the server keeps: "pipeline_last"). */}
              {!pipelineDraft.isNew && (pipelines.length > 1 || othersHidden) ? (
                <div className="mt-6 space-y-3 border-t border-line pt-4">
                  <p className="text-sm font-semibold text-ink">{`Remove ${nameOf(pipeline)}`}</p>
                  {pipelineDeals.length && !editable.some(p => p.id !== pipeline.id) ? (
                    // Its deals have nowhere to go that this person may change: said, never an empty choice.
                    <p className="text-sm text-ink-soft">{`Move its ${pipelineDeals.length === 1 ? "deal" : "deals"} to a pipeline you can change first.`}</p>
                  ) : pipelineDeals.length ? (
                    <label className="block">
                      <span className="field-label">{`Its ${pipelineDeals.length} ${pipelineDeals.length === 1 ? "deal goes" : "deals go"} to`}</span>
                      <select className="field mt-2" value={pipelineDraft.removeTo} onChange={e => setPipelineDraft({ ...pipelineDraft, removeTo: e.target.value })}>
                        <option value="">Choose a stage of another pipeline</option>
                        <StageOptions pipelines={editable.filter(p => p.id !== pipeline.id)} names={names} />
                      </select>
                    </label>
                  ) : <p className="text-sm text-ink-soft">It holds no deals.</p>}
                  {pipelineDeals.length && !editable.some(p => p.id !== pipeline.id) ? null : (
                    <button type="button" className="btn btn-secondary" disabled={locked || writeUnconfirmed || (pipelineDeals.length > 0 && !pipelineDraft.removeTo)} onClick={removePipeline}>
                      Remove this pipeline
                    </button>
                  )}
                </div>
              ) : null}
              {error ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}
            </fieldset>
          ) : canChange && !noneSeen ? (
            <button type="button" className="btn btn-secondary btn-sm" disabled={locked || editing || writeUnconfirmed} onClick={() => { setError(null); setPipelineDraft({ id: pipeline.id, name: pipeline.name, stages: structuredClone(pipeline.stages), isNew: false, moves: {}, removeTo: "" }); }}>
              {pipelines.length > 1 ? `Change ${nameOf(pipeline)} and its stages` : "Change the pipeline and its stages"}
            </button>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="crm-fields-title" id="fields" className="card min-w-0 scroll-mt-32 p-5 sm:p-8">
        <h2 id="crm-fields-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Your fields
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          {`Up to ${MAX_CRM_FIELDS} things you keep about each person: their company, a date, which offer interests them. Filled in on each person's page under Buyers, and written into your list's file as columns of their own. Removing a field removes every answer to it.`}
        </p>
        {fieldDraft ? (
          <fieldset disabled={locked} aria-busy={locked} aria-labelledby="crm-fields-title" className="min-w-0 mt-6 rounded-2xl border border-line bg-white p-4 sm:p-6">
            {/* Named by its visible heading, "Your fields", rather than a name only a screen reader hears. */}
            <ol className="space-y-3">
              {fieldDraft.map((field, i) => (
                <li key={field.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
                  <label className="block min-w-0">
                    <span className="text-sm text-ink-soft">{`Field ${i + 1}`}</span>
                    <input className="field mt-1" maxLength={MAX_FIELD_NAME} placeholder="Company" value={field.name} onChange={(e) => setFieldDraft(fieldDraft.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))} />
                  </label>
                  <label className="block min-w-0">
                    <span className="text-sm text-ink-soft">Kind</span>
                    <select className="field mt-1" aria-label={`Kind of field ${i + 1}`} value={field.type} onChange={(e) => setFieldDraft(fieldDraft.map((f, j) => (j === i ? { ...f, type: e.target.value as FieldType } : f)))}>
                      {FIELD_TYPES.map((t) => (
                        <option key={t.type} value={t.type}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFieldDraft(fieldDraft.filter((_, j) => j !== i))} aria-label={`Remove field ${i + 1}`}>
                    <Icon name="minus" size={16} />
                  </button>
                  {hasChoices(field.type) ? (
                    <label className="block min-w-0 sm:col-span-3">
                      <span className="text-sm text-ink-soft">Choices, separated by commas</span>
                      <input
                        className="field mt-1"
                        aria-label={`Choices, separated by commas, for field ${i + 1}`}
                        placeholder="Coaching, Course, Not sure yet"
                        value={field.optionsText}
                        onChange={(e) => setFieldDraft(fieldDraft.map((f, j) => (j === i ? { ...f, optionsText: e.target.value } : f)))}
                      />
                    </label>
                  ) : null}
                </li>
              ))}
            </ol>
            {fieldDraft.length < MAX_CRM_FIELDS ? (
              <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => setFieldDraft([...fieldDraft, { id: newCrmId(), name: "", type: "text", options: [], optionsText: "" }])}>
                <Icon name="plus" size={16} />
                Add a field
              </button>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                className="btn btn-primary"
                disabled={locked || writeUnconfirmed}
                onClick={() =>
                  void run(
                    { action: "fields", fields: fieldDraft.map(({ optionsText, ...f }) => ({ ...f, options: hasChoices(f.type) ? optionsText.split(",").map((o) => o.trim()).filter(Boolean) : [] })) },
                    "Fields saved.",
                    () => setFieldDraft(null),
                  )
                }
              >
                Save fields
              </button>
              <button type="button" className="btn btn-secondary" disabled={locked} onClick={() => setFieldDraft(null)}>
                Cancel
              </button>
            </div>
          {error ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}
          </fieldset>
        ) : (
          <>
            {fields.length ? (
              <ul className="mt-4 flex flex-wrap gap-2">
                {fields.map((f) => (
                  <li key={f.id} className="tag">{`${f.name} · ${FIELD_TYPES.find((t) => t.type === f.type)?.label ?? ""}`}</li>
                ))}
              </ul>
            ) : null}
            <button type="button" className="btn btn-secondary btn-sm mt-4" disabled={locked || editing || writeUnconfirmed} onClick={() => setFieldDraft(fields.map((f) => ({ ...f, optionsText: f.options.join(", ") })))}>
              {fields.length ? "Change the fields" : "Add your first field"}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
