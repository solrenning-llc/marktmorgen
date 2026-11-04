"use client";

import { useLeaveGuard } from "@/components/leave-guard";
import { PIPELINE_ACCESS_REFUSAL } from "@/lib/pipeline-access-rules";
import { dealActionFilter, filterDeals, type DealActionFilter } from "@/lib/crm-deal-filter";
import { dealOrder, orderDeals, dealWorklistCsv, type DealOrder, type DealView } from "@/lib/crm-deal-worklist";
import { DealAgenda } from "@/components/deal-agenda";
import { crmAnswer, type CrmAnswer, type CrmCurrentDeal } from "@/lib/crm-response";
import { MOVE_HINT, PIPELINE_NAME_ID, moveConflictWords, PIPELINE_REMOVE_TO_ID, SHOWN_SAY_AFTER_MS, VIEW_ONLY_WORDS, crmFieldChoicesId, crmFieldNameId, dealErrorField, fieldProblems, neighborAfterRemoval, pausedWords, pipelineProblems, shownWords, stageKindId, stageMovesId, stageNameId } from "@/lib/deal-board-focus";
import { DEAL_SAVE_ID, DRAFT_UNITS, changedFields, conflictFocus, conflictMessage, dealChanges, dealFieldId, draftFromDeal, emptyDraft, oneAtATime, rebaseDraft, refusalKind, savedNowText, savedNowId, stageMoveStep, stageChosenText, livePending, announce, focusWasLost, takeSaved, typedText, unitOf, DEAL_HIDDEN, DEAL_HIDDEN_ID, type DealDraft, type DraftField, type DraftConflict, type DraftUnit } from "@/lib/deal-draft";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
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

/**
 * The editor's deal, with the deal as it was opened (`base`) and that record's version: a save sends only what
 * changed. `conflicts` are the parts somebody else changed too, shown beside them after a refused save.
 */
type OpenDraft = DealDraft & { base: DealDraft; version: string; conflicts: DraftConflict[] };

/** What the board says when a deal changed on the server meanwhile (635 [GL3]); nothing the creator typed is lost. */

/** What a deal's worth must look like, said beside the field (3.3.1, 3.3.3). */
const MONEY_WORDS = "Type what it is worth as a number, like 1500 or 1500.50.";

/** The board's one status region (4.1.3): short words, said once, never at each key. */
const STATUS_ID = "deal-board-status";
/** The words saying why a control cannot be used now; every control that is off points to them (aria-describedby). */
const WHY_ID = "deal-board-why";
/** The count of deals shown, which "Download selected deals" points to when nothing is shown. */
const SHOWING_ID = "deal-showing";
/** The same words as WHY_ID, shown again inside the open editor beside its own controls while they are off. */
const EDITOR_WHY_ID = "deal-board-editor-why";
/** Why a stage's Up or Down does nothing at the top or the bottom. */
const STAGE_EDGES_ID = "stage-edges";

/**
 * A control that cannot be used now stays where it is and keeps focus (2.4.3,
 * 2.4.11): aria-disabled instead of disabled, its press ignored by its own
 * handler, and why it is off said beside it (`why`, through aria-describedby).
 */
function offProps(off: boolean, why: string | undefined, describedBy?: string) {
  const ids = [describedBy, off ? why : undefined].filter(Boolean).join(" ");
  return { "aria-disabled": off || undefined, "aria-describedby": ids || undefined };
}


const KIND_WORDS: Record<StageKind, string> = { open: "Open", won: "Won", lost: "Lost" };

/**
 * A store's deals, stage by stage (lib/crm-rules.ts): what each is worth,
 * who it is with, and a way to move it on. The stages are the store's own,
 * and so are the fields kept about each person, made here too.
 */
type PipelineDraft = { id: string; name: string; stages: Stage[]; isNew: boolean; moves: Record<string, string>; removeTo: string };

/** The stages of every pipeline, grouped, for a choice of stage: a deal can be put in any pipeline. */
function StageOptions({ pipelines, except }: { pipelines: readonly Pipeline[]; except?: ReadonlySet<string> }) {
  const shown = pipelines.map(p => ({ ...p, stages: p.stages.filter(s => !except?.has(s.id)) })).filter(p => p.stages.length);
  if (shown.length < 2) return <>{shown.flatMap(p => p.stages).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</>;
  return <>{shown.map(p => <optgroup key={p.id} label={p.name}>{p.stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>)}</>;
}

export function DealsBoard({ deals, versions = {}, stages: everyStage, pipelines: savedPipelines, pipelineMax = 1, fields, currency, assignees, today, initialFilter = "all", requestHref, viewOnly, someHidden = false }: { deals: Deal[]; /** Each deal's version (lib/crm.ts, dealVersion), sent back with a change to it. */ versions?: Record<string, string>; stages: Stage[]; /** The store's pipelines (lib/crm-rules.ts); the first holds the board it always had. */ pipelines?: Pipeline[]; /** How many pipelines the store's plan may have. */ pipelineMax?: number; fields: CrmField[]; currency: string; assignees: string[]; today: string; initialFilter?: DealActionFilter; /** The payment requests page, for a role that may send them; a deal with a person links to it, filled in. */ requestHref?: string; /** Pipelines this person may see but not change (639 [GL7](7)): their deals are shown without the controls that change them. */ viewOnly?: string[]; /** Someone who may not see every pipeline (639 [GL7](7)): the store's pipeline count is never said, so it cannot tell how many are hidden. */ someHidden?: boolean }) {
  const router = useRouter();
  const pipelines: Pipeline[] = savedPipelines?.length ? savedPipelines : [firstPipeline(everyStage)];
  const [pipelineId, setPipelineId] = useState(pipelines[0].id);
  const pipeline = pipelines.find(p => p.id === pipelineId) ?? pipelines[0];
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
  const [draft, setDraft] = useState<OpenDraft | null>(null);
  // The control that opened the editor now open, so closing it gives focus back there (2.4.3).
  const opener = useRef<string | null>(null);
  // What is wrong in the open editor, tied to each control it is about (3.3.1, 3.3.3): those controls are
  // aria-invalid, point to the words beside the first one, and the first one gets focus.
  const [invalid, setInvalid] = useState<{ ids: string[]; message: string } | null>(null);
  // The deal whose removal is waiting for "Remove deal" or "Keep deal" (3.3.6), and the stage it was in when asked: nothing is removed before.
  const [confirming, setConfirming] = useState<{ id: string; stage: string } | null>(null);
  const clearMessages = () => { setError(null); setInvalid(null); setLost(null); setConfirming(null); };
  const openDraft = (deal: Deal, from: string) => { opener.current = from; const base = draftFromDeal(deal, currency); clearMessages(); setDraft({ ...base, base, version: versions[deal.id] ?? "", conflicts: [] }); };
  const dealNameInput = useRef<HTMLInputElement>(null);
  const activeDealId = draft?.id;
  useEffect(() => { if (activeDealId !== undefined) dealNameInput.current?.focus(); }, [activeDealId]);
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [writeUnconfirmed, setWriteUnconfirmed] = useState(false);
  const locked = busy || refreshing;
  // Decided at once, not at the next render: a second change (a keyboard moving a stage select a step at a time) is not sent.
  const gate = useRef(oneAtATime());
  // Where focus goes back once the board is usable again: a disabled control loses it while a change is saved.
  // The first of `ids` on the page gets it, and only if focus was lost (never taken from where the person moved it).
  const focusTo = useRef<string[]>([]);
  // A move the person asked for (opening a confirmation, an error's field, a moved stage): made even if focus was not lost.
  const focusForce = useRef(false);
  const [focusTick, setFocusTick] = useState(0);
  const focusLater = (...ids: (string | null | undefined)[]) => { focusTo.current = ids.filter((id): id is string => !!id); focusForce.current = false; setFocusTick(t => t + 1); };
  const moveFocus = (...ids: (string | null | undefined)[]) => { focusLater(...ids); focusForce.current = true; };
  // A layout effect, so focus moves in the same commit that draws its target (an error's words, aria-invalid):
  // a passive effect runs after the paint in a later task when the update came from a server answer, so for a
  // moment the error was on the page while focus was still on Save, and a browser (WebKit) could keep it there.
  useLayoutEffect(() => {
    if (locked || !focusTo.current.length) return;
    const target = focusTo.current.map(id => document.getElementById(id)).find(el => el !== null);
    const force = focusForce.current;
    focusTo.current = [];
    focusForce.current = false;
    if (target && (force || focusWasLost(document.activeElement, document.body))) target.focus();
  }, [locked, focusTick]);
  // The board's one status region (4.1.3): "Use this" taking what is saved now, a stage chosen, a change being
  // saved, how many deals a search shows. Words said twice in a row are said again (announce).
  const [status, setStatus] = useState("");
  // Words said after a pause (a stage chosen with the arrow keys): only the last choice is said, never one at each key.
  const sayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = (words: string) => { if (sayTimer.current) clearTimeout(sayTimer.current); sayTimer.current = null; setStatus(previous => announce(previous, words)); };
  const sayCancel = () => { if (sayTimer.current) clearTimeout(sayTimer.current); sayTimer.current = null; };
  const sayLater = (words: string) => { if (sayTimer.current) clearTimeout(sayTimer.current); sayTimer.current = setTimeout(() => { sayTimer.current = null; setStatus(previous => announce(previous, words)); }, SHOWN_SAY_AFTER_MS); };
  useEffect(() => () => { if (sayTimer.current) clearTimeout(sayTimer.current); }, []);
  // What the creator typed in a deal that moved where they cannot change it, kept for them to copy (3.3.7).
  const [lost, setLost] = useState<string | null>(null);
  // A stage chosen on a card's select and not sent yet (3.2.5): sent on Enter or when the select is left.
  const [moving, setMoving] = useState<Record<string, string>>({});
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
  // The question stays open only while its deal is on the board where it was asked: hidden by a search or a filter, the agenda
  // shown, another pipeline chosen or the deal moved, it closes for good, so it never comes back by itself on the card (3.2.5).
  // Cleared while rendering, never shown for a frame: focus is not inside it then (it is on the control that hid or moved the deal).
  const confirmingId = confirming && view === "board" && visibleDeals.some(d => d.id === confirming.id && d.stage === confirming.stage) ? confirming.id : null;
  if (confirming && !confirmingId) setConfirming(null);
  const selectionChanged = !!search || responsible !== "all" || filter !== "all" || order !== (view === "agenda" ? "due" : "current");
  const open = totals.filter((t) => t.stage.kind === "open");
  const won = totals.filter((t) => t.stage.kind === "won");
  // How many deals a search or a filter shows, said in the status region once the person stops typing (never at each key).
  const selectionKey = JSON.stringify([search, responsible, filter, order, view, pipeline.id]);
  const saidSelection = useRef(selectionKey);
  const shownCount = visibleDeals.length;
  const loadedCount = pipelineDeals.length;
  useEffect(() => {
    if (selectionKey === saidSelection.current) return;
    const timer = setTimeout(() => {
      saidSelection.current = selectionKey;
      setStatus(previous => announce(previous, shownWords(shownCount, loadedCount)));
    }, SHOWN_SAY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [selectionKey, shownCount, loadedCount]);

  /** Marks the controls an error is about, says it beside the first, and takes focus there (3.3.1, 3.3.3). */
  /** A control changed after an error about it is no longer marked invalid; the error's words move to the next one still wrong, or go. */
  const fixed = (...gone: string[]) => setInvalid(previous => {
    if (!previous || !previous.ids.some(id => gone.includes(id))) return previous;
    const ids = previous.ids.filter(id => !gone.includes(id));
    return ids.length ? { ...previous, ids } : null;
  });
  const showInvalid = (ids: string[], message: string) => {
    setError(null);
    setInvalid({ ids, message });
    moveFocus(ids[0]);
  };

  async function run(body: Record<string, unknown>, done: string, after?: () => void, onConflict?: (current: CrmCurrentDeal) => void, refocus?: string | readonly string[], invalidFor?: (error: string) => string[]) {
    if (locked || writeUnconfirmed || !gate.current.enter()) return;
    setBusy(true);
    setError(null);
    setInvalid(null);
    say("Saving your change.");
    const answer = await call(body);
    gate.current.leave();
    setBusy(false);
    if (answer.ok) {
      toast(answer.workflows === "not_checked" ? `${done} The workflow for this stage was not started for this person.` : done);
      after?.();
      startRefresh(() => router.refresh());
      return;
    }
    if (answer.error === "crm_write_unconfirmed") setWriteUnconfirmed(true);
    // Back where the change was asked, or, when that control is gone (the deal left the board), the next place in the list.
    focusLater(...(typeof refocus === "string" ? [refocus] : refocus ?? []));
    // The deal changed meanwhile: nothing was written; the board takes the deal as it is now and loads the rest.
    const kind = refusalKind(body.action, answer, stage => editable.some(p => p.stages.some(st => st.id === stage)));
    if (kind === "rebase" && answer.current && onConflict) {
      onConflict(answer.current);
      startRefresh(() => router.refresh());
      return;
    }
    // Changed and moved to a pipeline this person cannot see: nothing to put the changes back on, so the editor closes.
    if (kind === "hidden") {
      const typed = draft?.id && body.action === "deal" ? typedText(draft.base, draft, stageName) : "";
      setLost(typed || null);
      focusLater(typed ? DEAL_HIDDEN_ID : "deal-board-alert");
      setDraft(null);
      setError(DEAL_HIDDEN);
      startRefresh(() => router.refresh());
      return;
    }
    // A refusal about one field is said beside that field, which gets focus; any other in the alert, said once.
    const fieldIds = invalidFor?.(answer.error) ?? [];
    if (fieldIds.length) {
      showInvalid(fieldIds, MESSAGES[answer.error] ?? MESSAGES.server_error);
      return;
    }
    setError(MESSAGES[answer.error] ?? MESSAGES.server_error);
  }

  function downloadWorklist() {
    if (!visibleDeals.length || locked || writeUnconfirmed) return;
    const csv = dealWorklistCsv(visibleDeals, stages.map(s => ({ ...s, name: stageLabel(pipelines, s) })), { today, currency, query: search, responsible, filter, order, view });
    const address = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = address;
    link.download = "deal-worklist-" + (pipelines.length > 1 ? pipeline.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" : "") + today + ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(address), 1000);
  }

  /** Closes the deal editor and gives focus back to what opened it (the card's or the agenda's Edit, or New deal). */
  const closeDeal = () => {
    setDraft(null);
    setError(null);
    setInvalid(null);
    focusLater(opener.current, "deal-new", "deals-title");
  };
  const dealInvalidFor = (error: string) => { const id = dealErrorField(error); return id ? [id] : []; };

  function saveDeal() {
    if (!draft || locked || writeUnconfirmed) return;
    const opened = draft;
    const badMoney = () => showInvalid([dealFieldId("value")], MONEY_WORDS);
    // A deal needs a name: said beside it before anything is sent.
    if (!opened.title.trim()) return showInvalid([dealFieldId("title")], MESSAGES.title);
    if (!opened.id) {
      const cents = opened.value.trim() ? readMoney(opened.value, currency as Currency) : 0;
      if (cents === null) return badMoney();
      void run({ action: "deal", deal: { title: opened.title, email: opened.email, cents, stage: opened.stage, note: opened.note, nextAction: opened.nextAction, dueDate: opened.dueDate, assignee: opened.assignee } }, "Deal added.", closeDeal, undefined, DEAL_SAVE_ID, dealInvalidFor);
      return;
    }
    // Nothing changed: nothing to send, and the deal is left exactly as it is.
    if (!changedFields(opened.base, opened).length) {
      closeDeal();
      toast("Nothing changed, so nothing was saved.");
      return;
    }
    // Only what the creator changed since opening it, over the record they opened (635 [GL3]).
    const changes = dealChanges(opened.base, opened, currency);
    if (!changes) return badMoney();
    void run({ action: "deal", version: opened.version, deal: changes }, "Deal saved.", closeDeal, (current) => {
      const base = draftFromDeal(current.deal, currency);
      const rebased = rebaseDraft(opened.base, opened, current.deal, currency);
      setDraft({ ...rebased.draft, base, version: current.version, conflicts: rebased.conflicts });
      setError(conflictMessage(rebased.conflicts));
      // Focus is on Save, not lost: it is moved to the first part in conflict (2.4.3, 3.3.1).
      moveFocus(conflictFocus(rebased.conflicts));
    }, DEAL_SAVE_ID, dealInvalidFor);
  }

  const firstOpen = stages.find((s) => s.kind === "open")?.id ?? stages[0]?.id ?? "";
  const stageName = (id: string) => pipelines.flatMap(p => p.stages).find(st => st.id === id)?.name ?? "a stage that is gone";
  // The open editor's error, tied to its controls (3.3.1): each one in error is aria-invalid and points to the words beside the first.
  const errorId = invalid ? `${invalid.ids[0]}-error` : undefined;
  const bad = (id: string) => !!invalid?.ids.includes(id);
  // While a change is saved, an editor's controls are off (read-only, never disabled): marked aria-disabled, drawn so (app/globals.css),
  // and pointing to the words beside the editor's buttons saying why.
  const badProps = (id: string, describedBy?: string) => ({ "aria-invalid": bad(id) || undefined, "aria-disabled": locked || undefined, "aria-describedby": [describedBy, bad(id) ? errorId : undefined, locked ? EDITOR_WHY_ID : undefined].filter(Boolean).join(" ") || undefined });
  const errorBeside = (id: string, className = "") => (invalid && invalid.ids[0] === id ? <p id={errorId} className={`field-error ${className}`}>{invalid.message}</p> : null);
  // What is saved now for a part somebody else changed too, beside it, with a way to take it (3.3.1, 3.3.3).
  const savedNow = (unit: DraftUnit) => {
    const conflict = draft?.conflicts.find(c => c.unit === unit);
    if (!draft || !conflict) return null;
    const label = DRAFT_UNITS.find(u => u.unit === unit)!.label;
    return (
      <p className="sm:col-span-2 flex flex-wrap items-center gap-2 text-sm text-ink-soft [overflow-wrap:anywhere]">
        <span id={savedNowId(unit)}>{`Saved now: ${savedNowText(conflict, currency, stageName)}`}</span>
        <button type="button" className="btn btn-secondary btn-sm" {...offProps(locked, EDITOR_WHY_ID)} onClick={() => { if (locked) return; const taken = takeSaved(draft, unit); setDraft(taken.draft); say(taken.said); focusLater(taken.focus); }}>
          Use this<span className="sr-only">{` for ${label}`}</span>
        </button>
      </p>
    );
  };
  // A field points to the "Saved now" words beside it when in conflict, and to its error when it has one (aria-describedby).
  const describedBy = (field: DraftField) => [draft?.conflicts.some(c => c.unit === unitOf(field)) ? savedNowId(unitOf(field)) : undefined, bad(dealFieldId(field)) ? errorId : undefined, locked ? EDITOR_WHY_ID : undefined].filter(Boolean).join(" ") || undefined;
  // A change typed while the deal is being saved is not taken (the fields are read-only meanwhile, never disabled, so focus stays).
  const put = (patch: Partial<DealDraft>) => {
    if (!draft || locked) return;
    setDraft({ ...draft, ...patch });
    for (const field of Object.keys(patch) as DraftField[]) fixed(dealFieldId(field));
  };
  /** Whether a deal in this pipeline is shown under the search, the teammate and the action filter chosen now. */
  const shownHere = (d: Deal) => filterDeals([d], search, responsible === "all" ? null : responsible === "unassigned" ? "" : responsible.slice(7)).length > 0 && (filter === "all" || dealFollowUps(stages, [d], today)[filter as keyof ReturnType<typeof dealFollowUps>].some(x => x.id === d.id));
  function moveDeal(deal: Deal, stage: string) {
    // Focus goes back to the deal's stage select after, moved or refused: the card may now be in another stage. When the deal
    // is no longer shown (another pipeline, or out of the filter), it goes to the next deal of the stage it left, else the one
    // before, else that stage's heading, else the board's title (2.4.3).
    const neighbor = neighborAfterRemoval(visibleDeals.filter(d => d.stage === deal.stage).map(d => d.id), deal.id);
    const places = [`deal-stage-${deal.id}`, ...(neighbor ? [`deal-stage-${neighbor}`] : []), `deal-column-${deal.stage}`, "deals-title"];
    focusLater(...places);
    // Refused because the deal changed meanwhile: said in words that fit where it is now (here, out of this search or filter, or in another pipeline).
    const refused = (current: CrmCurrentDeal) => setError(moveConflictWords(here.has(current.deal.stage) ? (shownHere(current.deal) ? "here" : "filtered") : { pipeline: pipelines.find(p => p.stages.some(st => st.id === current.deal.stage))?.name ?? "another pipeline" }));
    void run({ action: "deal", version: versions[deal.id] ?? "", deal: { id: deal.id, stage } }, here.has(stage) ? "Deal moved." : `Deal moved to ${pipelines.find(p => p.stages.some(st => st.id === stage))?.name ?? "another pipeline"}.`, undefined, refused, places);
  }
  function stageEvent(deal: Deal, event: Parameters<typeof stageMoveStep>[1]) {
    // Nothing is chosen or sent while the board is paused: the select keeps showing where the deal is.
    if (paused) return;
    const step = stageMoveStep(pendingMoves[deal.id], event, deal.stage);
    setMoving(m => { const next = { ...m }; if (step.pending === undefined) delete next[deal.id]; else next[deal.id] = step.pending; return next; });
    // Said once the person stops choosing (arrowing through the stages says nothing at each one).
    if (event.kind === "change") {
      if (step.pending !== undefined) sayLater(stageChosenText(step.pending, stageName));
      // Back where it is: a choice not said yet is never said.
      else sayCancel();
    }
    if (step.commit) moveDeal(deal, step.commit);
  }
  /** "Remove deal", once confirmed (3.3.6): focus then goes to the next deal of the stage, else the one before, else the stage's heading. */
  function removeDeal(deal: Deal) {
    if (locked || writeUnconfirmed) return;
    const neighbor = neighborAfterRemoval(visibleDeals.filter(d => d.stage === deal.stage).map(d => d.id), deal.id);
    void run({ action: "undeal", id: deal.id }, "Deal removed.", () => { setConfirming(null); focusLater(neighbor ? `deal-stage-${neighbor}` : null, `deal-column-${deal.stage}`, "deals-title"); }, undefined, `deal-confirm-yes-${deal.id}`);
  }
  const keepDeal = (id: string) => { setConfirming(null); focusLater(`deal-remove-${id}`); };
  const initialFields = fields.map(field => ({ ...field, optionsText: field.options.join(", ") }));
  const pipelineDirty = pipelineDraft !== null && (pipelineDraft.isNew || pipelineDraft.name !== pipeline.name || JSON.stringify(pipelineDraft.stages) !== JSON.stringify(pipeline.stages));
  // Stages chosen and not sent, only while they still mean something: a deal still on the board, not where it is
  // already, and nothing else under way (an editor open, a change being saved drops them).
  const blocked = locked || draft !== null || pipelineDraft !== null || fieldDraft !== null;
  const [wasBlocked, setWasBlocked] = useState(blocked);
  if (blocked !== wasBlocked) {
    setWasBlocked(blocked);
    if (blocked) setMoving({});
  }
  const pendingMoves = blocked ? {} : livePending(moving, deals);
  // A stage choice not said yet is never said once it is dropped (an editor opened, a change saved, the deal moved).
  const pendingCount = Object.keys(pendingMoves).length;
  useEffect(() => {
    if ((blocked || pendingCount === 0) && sayTimer.current) {
      clearTimeout(sayTimer.current);
      sayTimer.current = null;
    }
  }, [blocked, pendingCount]);
  const dirty = (draft !== null && changedFields(draft.base, draft).length > 0) || Object.keys(pendingMoves).length > 0 || pipelineDirty || (fieldDraft !== null && JSON.stringify(fieldDraft) !== JSON.stringify(initialFields));
  useLeaveGuard(dirty);
  const editing = draft !== null || pipelineDraft !== null || fieldDraft !== null;
  // Controls that start a change are off while one is saved, an editor is open, or a change could not be confirmed;
  // they stay focusable and point to the words saying why (AX274: 2.4.3, 2.4.11, 3.3.5).
  const paused = locked || editing || writeUnconfirmed;
  const why = pausedWords({ unconfirmed: writeUnconfirmed, saving: busy, refreshing, editing });
  // How many deals each saved stage holds now: a stage removed with deals in it asks where they go.
  const dealsIn = (stageId: string) => deals.filter(d => d.stage === stageId).length;

  /** Opens the pipeline editor from the control `from`, with focus on its name (2.4.3). */
  const pipelineOpened = (from: string) => { opener.current = from; clearMessages(); moveFocus(PIPELINE_NAME_ID); };
  const openPipeline = (next: PipelineDraft, from: string) => { setPipelineDraft(next); pipelineOpened(from); };
  const closePipeline = (...then: (string | null | undefined)[]) => { setPipelineDraft(null); setError(null); setInvalid(null); focusLater(...then, opener.current, "pipeline-change", "deals-title"); };

  function savePipeline() {
    if (!pipelineDraft || locked || writeUnconfirmed) return;
    // What the board can see is wrong is said beside it before anything is sent.
    const problems = pipelineProblems(pipelineDraft, pipelines.filter(p => p.id !== pipelineDraft.id).map(p => p.name));
    if (problems.length) return showInvalid(problems, problems.includes(PIPELINE_NAME_ID) ? MESSAGES.pipelines : MESSAGES.stages);
    const kept = new Set(pipelineDraft.stages.map(s => s.id));
    const gone = pipelineDraft.isNew ? [] : pipeline.stages.filter(s => !kept.has(s.id) && dealsIn(s.id) > 0);
    const unplaced = gone.filter(s => !pipelineDraft.moves[s.id]).map(s => stageMovesId(s.id));
    if (unplaced.length) return showInvalid(unplaced, MESSAGES.moves);
    const moves = Object.fromEntries(gone.map(s => [s.id, pipelineDraft.moves[s.id]]));
    const saved = pipelineDraft;
    void run({ action: "pipeline", pipeline: { id: pipelineDraft.id, name: pipelineDraft.name, stages: pipelineDraft.stages }, moves }, pipelineDraft.isNew ? "Pipeline added." : gone.length ? "Pipeline saved, and its deals moved." : "Pipeline saved.", () => { if (saved.isNew) setPipelineId(saved.id); closePipeline(saved.isNew ? `pipeline-tab-${saved.id}` : null); }, undefined, "pipeline-save", error => error === "pipelines" ? [PIPELINE_NAME_ID] : error === "stages" ? pipelineProblems(saved, []) : error === "moves" ? gone.map(s => stageMovesId(s.id)) : []);
  }

  function removePipeline() {
    if (!pipelineDraft || pipelineDraft.isNew || locked || writeUnconfirmed) return;
    const holding = pipelineDeals.length;
    if (holding && !pipelineDraft.removeTo) return showInvalid([PIPELINE_REMOVE_TO_ID], MESSAGES.moves);
    const next = pipelines.find(p => p.id !== pipeline.id)?.id ?? pipelines[0].id;
    void run({ action: "unpipeline", id: pipeline.id, moveTo: pipelineDraft.removeTo }, holding ? `Pipeline removed; its ${holding === 1 ? "deal was" : `${holding} deals were`} moved.` : "Pipeline removed.", () => { setPipelineId(next); closePipeline(`pipeline-tab-${next}`); }, undefined, "pipeline-remove", error => error === "moves" ? [PIPELINE_REMOVE_TO_ID] : []);
  }

  // A change typed in the pipeline editor while it is being saved is not taken.
  const putPipeline = (next: PipelineDraft) => { if (!locked) setPipelineDraft(next); };
  const moveStage = (from: number, to: number) => {
    if (!pipelineDraft || to < 0 || to >= pipelineDraft.stages.length) return;
    const next = [...pipelineDraft.stages];
    const [one] = next.splice(from, 1);
    next.splice(to, 0, one);
    setPipelineDraft({ ...pipelineDraft, stages: next });
  };

  /** Opens the fields editor, with focus on its first field's name, or on "Add a field" when there is none (2.4.3). */
  const openFields = () => { opener.current = "crm-fields-change"; clearMessages(); setFieldDraft(fields.map((f) => ({ ...f, optionsText: f.options.join(", ") }))); moveFocus(fields[0] ? crmFieldNameId(fields[0].id) : "crm-field-add"); };
  // A change typed in the fields editor while it is being saved is not taken.
  const putFields = (next: NonNullable<typeof fieldDraft>) => { if (!locked) setFieldDraft(next); };
  const closeFields = () => { setFieldDraft(null); setError(null); setInvalid(null); focusLater("crm-fields-change"); };
  function saveFields() {
    if (!fieldDraft || locked || writeUnconfirmed) return;
    const problems = fieldProblems(fieldDraft);
    if (problems.length) return showInvalid(problems, MESSAGES.fields);
    const sent = fieldDraft;
    void run(
      { action: "fields", fields: fieldDraft.map(({ optionsText, ...f }) => ({ ...f, options: hasChoices(f.type) ? optionsText.split(",").map((o) => o.trim()).filter(Boolean) : [] })) },
      "Fields saved.",
      closeFields,
      undefined,
      "crm-fields-save",
      error => error === "fields" ? fieldProblems(sent) : [],
    );
  }

  return (
    <div className="space-y-8">
      {/* The board's one status region (4.1.3): always there, short words, said once. */}
      <p id={STATUS_ID} role="status" className="sr-only">{status}</p>
      {/* Why controls are off now, shown once and pointed to by each of them (aria-describedby); not a live region, so never said twice. */}
      {why ? <p id={WHY_ID} className={`notice ${writeUnconfirmed || (editing && !locked) ? "notice-warn" : ""}`}>{why}</p> : null}
      <section aria-labelledby="deals-title" className="card min-w-0 p-5 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-2xl">
            <h2 id="deals-title" tabIndex={-1} className="text-lg font-semibold tracking-[-0.02em] text-ink">
              Deals
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              {`People you are talking to about something sold outside a checkout: a coaching package, a custom project.${pipelines.length > 1 ? ` In ${pipeline.name}:` : ""} ${open.reduce((n, t) => n + t.count, 0)} open, worth ${money(open.reduce((n, t) => n + t.cents, 0))}; won so far, ${money(won.reduce((n, t) => n + t.cents, 0))}.`}
            </p>
          </div>
          {draft === null && canChange ? (
            <button type="button" id="deal-new" className="btn btn-primary" {...offProps(paused, WHY_ID)} onClick={() => { if (paused) return; opener.current = "deal-new"; const base = emptyDraft(firstOpen); clearMessages(); setDraft({ ...base, base, version: "", conflicts: [] }); }}>
              <Icon name="plus" size={18} />
              New deal
            </button>
          ) : null}
        </div>
        {/* Said once, at the top of the board, for a pipeline this person may only see (639 [GL7](7)); a refused change says why too. */}
        {!canChange ? <p id="deal-board-view-only" className="notice mt-4">{VIEW_ONLY_WORDS}</p> : null}

        <div className="mt-5" role="group" aria-label="Pipelines">
          <div className="flex flex-wrap items-center gap-2">
            {allTotals.map(t => (
              <button key={t.pipeline.id} id={`pipeline-tab-${t.pipeline.id}`} type="button" aria-pressed={t.pipeline.id === pipeline.id} {...offProps(editing && t.pipeline.id !== pipeline.id, WHY_ID)} className={`btn btn-sm ${t.pipeline.id === pipeline.id ? "btn-primary" : "btn-secondary"}`} onClick={() => { if (editing || t.pipeline.id === pipeline.id) return; setPipelineId(t.pipeline.id); setError(null); setConfirming(null); }}>
                {t.pipeline.name}
                <span className="tabular-nums opacity-80">{` · ${t.open.count} open`}</span>
                {readOnly.has(t.pipeline.id) ? <span className="opacity-80"> · view only</span> : null}
              </button>
            ))}
            {pipelines.length < pipelineMax ? (
              <button type="button" id="pipeline-new" className="btn btn-ghost btn-sm" {...offProps(paused, WHY_ID)} onClick={() => { if (!paused) openPipeline({ id: newCrmId(), name: "", stages: starterStages(), isNew: true, moves: {}, removeTo: "" }, "pipeline-new"); }}>
                <Icon name="plus" size={16} />
                New pipeline
              </button>
            ) : null}
            {pipelines.length < pipelineMax && canChange ? (
              /* 639 [GL7](8): the same stages under a new name, none of its deals; opened to read and save, nothing saved yet. */
              <button type="button" id="pipeline-copy" className="btn btn-ghost btn-sm" {...offProps(paused, WHY_ID)} onClick={() => { if (paused) return; const copy = copyPipeline(pipeline, pipelines); setPipelineDraft({ ...copy, isNew: true, moves: {}, removeTo: "" }); pipelineOpened("pipeline-copy"); }}>
                <Icon name="plus" size={16} />
                {`Duplicate “${pipeline.name}”`}
              </button>
            ) : null}
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <caption className="sr-only">What each pipeline&apos;s deals add up to</caption>
              <thead><tr className="text-ink-soft">{["Pipeline", "Open", "Won", "Lost"].map(label => <th key={label} scope="col" className="py-2 pr-4 font-semibold">{label}</th>)}</tr></thead>
              <tbody>{allTotals.map(t => (
                <tr key={t.pipeline.id} className="border-t border-line">
                  <th scope="row" className="py-2 pr-4 font-semibold text-ink [overflow-wrap:anywhere]">{t.pipeline.name}</th>
                  {(["open", "won", "lost"] as const).map(k => <td key={k} className="py-2 pr-4 tabular-nums text-ink-soft">{`${t[k].count} · ${money(t[k].cents)}`}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-mute">{`Each total adds up the values recorded on its deals, in ${currency.toUpperCase()}. Nothing is weighted or forecast. ${someHidden ? (pipelines.length < pipelineMax ? "Your store can add another pipeline." : "Your store has no room for another pipeline.") : `You have ${pipelines.length} of the ${pipelineMax} ${pipelineMax === 1 ? "pipeline" : "pipelines"} your store can keep.`}`}</p>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="block"><span className="field-label">Find a deal</span><input type="search" id="deal-search" className="field mt-2" maxLength={80} value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, email, next action or note" /></label><label className="block"><span className="field-label">Responsible teammate</span><select className="field mt-2" value={responsible} onChange={e => setResponsible(e.target.value)}><option value="all">Everyone</option><option value="unassigned">Unassigned</option>{responsibleChoices.map(email => <option key={email} value={"person:" + email}>{email}{assignees.includes(email) ? "" : " (no longer eligible)"}</option>)}</select></label></div>
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
            <button type="button" className="btn btn-secondary btn-sm" {...offProps(!visibleDeals.length || locked || writeUnconfirmed, [!visibleDeals.length ? SHOWING_ID : "", locked || writeUnconfirmed ? WHY_ID : ""].filter(Boolean).join(" "))} onClick={downloadWorklist}>Download selected deals</button>
            {/* The button goes once there is nothing to clear, so focus goes to the search box it cleared (2.4.3). */}
            {selectionChanged ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSearch(""); setResponsible("all"); setFilter("all"); setOrder(view === "agenda" ? "due" : "current"); focusLater("deal-search"); }}>Clear selection</button> : null}
          </div>
        </div>
        {/* Not a live region: the status region above says the count once the person stops typing. */}
        <p id={SHOWING_ID} className="mt-2 text-xs text-ink-mute">{`Showing ${visibleDeals.length.toLocaleString("en-US")} of ${pipelineDeals.length.toLocaleString("en-US")} loaded deals${pipelines.length > 1 ? " in this pipeline" : ""}. The CSV follows these filters and the ${view === "agenda" ? "order across all stages" : "order within each stage"}. Recorded values are opportunity estimates, not confirmed revenue.`}</p>

        {draft ? (
          // Never disabled while saving, so the focused control keeps focus (2.4.3): fields are read-only meanwhile.
          <fieldset aria-busy={locked} className="min-w-0 mt-6 rounded-2xl border border-line bg-white p-4 sm:p-6">
            <legend className="sr-only">Deal details</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="field-label">What it is</span>
                <input ref={dealNameInput} id={dealFieldId("title")} aria-describedby={describedBy("title")} aria-invalid={bad(dealFieldId("title")) || undefined} readOnly={locked} aria-disabled={locked || undefined} className="field mt-2" maxLength={MAX_DEAL_TITLE} value={draft.title} placeholder="Six coaching sessions for Dana" onChange={(e) => put({ title: e.target.value })} />
              </label>
              {errorBeside(dealFieldId("title"), "sm:col-span-2")}
              {savedNow("title")}
              <label className="block">
                <span className="field-label">Their email (optional)</span>
                <input id={dealFieldId("email")} aria-describedby={describedBy("email")} aria-invalid={bad(dealFieldId("email")) || undefined} readOnly={locked} aria-disabled={locked || undefined} className="field mt-2" type="email" autoComplete="off" value={draft.email} onChange={(e) => put({ email: e.target.value })} />
              </label>
              {errorBeside(dealFieldId("email"), "sm:col-span-2")}
              {savedNow("email")}
              <label className="block">
                <span className="field-label">{`What it is worth, in ${currency.toUpperCase()} (optional)`}</span>
                <input id={dealFieldId("value")} aria-describedby={describedBy("value")} aria-invalid={bad(dealFieldId("value")) || undefined} readOnly={locked} aria-disabled={locked || undefined} className="field mt-2" inputMode="decimal" value={draft.value} placeholder="1500" onChange={(e) => put({ value: e.target.value })} />
              </label>
              {errorBeside(dealFieldId("value"), "sm:col-span-2")}
              {savedNow("value")}
              <label className="block">
                <span className="field-label">{pipelines.length > 1 ? "Pipeline and stage" : "Stage"}</span>
                <select id={dealFieldId("stage")} aria-describedby={describedBy("stage")} aria-invalid={bad(dealFieldId("stage")) || undefined} aria-disabled={locked || undefined} className="field mt-2" value={draft.stage} onChange={(e) => put({ stage: e.target.value })}>
                  <StageOptions pipelines={editable} />
                </select>
              </label>
              {errorBeside(dealFieldId("stage"), "sm:col-span-2")}
              {savedNow("stage")}
              <label className="block sm:col-span-2">
                <span className="field-label">Next action (optional)</span>
                <input id={dealFieldId("nextAction")} aria-describedby={describedBy("nextAction")} aria-invalid={bad(dealFieldId("nextAction")) || undefined} readOnly={locked} aria-disabled={locked || undefined} className="field mt-2" maxLength={200} value={draft.nextAction} placeholder="Follow up on the proposal" onChange={e => put({ nextAction: e.target.value })} />
              </label>
              {errorBeside(dealFieldId("nextAction"), "sm:col-span-2")}
              <label className="block">
                <span className="field-label">Action date (optional, UTC calendar date)</span>
                <input id={dealFieldId("dueDate")} aria-describedby={describedBy("dueDate")} aria-invalid={bad(dealFieldId("dueDate")) || undefined} readOnly={locked} aria-disabled={locked || undefined} className="field mt-2" type="date" value={draft.dueDate} onChange={e => put({ dueDate: e.target.value })} />
              </label>
              {errorBeside(dealFieldId("dueDate"), "sm:col-span-2")}
              {savedNow("followUp")}
              <label className="block">
                <span className="field-label">Responsible teammate (optional)</span>
                <select id={dealFieldId("assignee")} aria-describedby={describedBy("assignee")} aria-invalid={bad(dealFieldId("assignee")) || undefined} aria-disabled={locked || undefined} className="field mt-2" value={draft.assignee} onChange={e => put({ assignee: e.target.value })}>
                  <option value="">Unassigned</option>
                  {draft.assignee && !assignees.includes(draft.assignee) ? <option value={draft.assignee}>{draft.assignee} (no longer eligible)</option> : null}
                  {assignees.map(email => <option key={email} value={email}>{email}</option>)}
                </select>
              </label>
              {errorBeside(dealFieldId("assignee"), "sm:col-span-2")}
              {savedNow("assignee")}
              <label className="block sm:col-span-2">
                <span className="field-label">A note (optional)</span>
                <textarea id={dealFieldId("note")} aria-describedby={describedBy("note")} aria-invalid={bad(dealFieldId("note")) || undefined} readOnly={locked} aria-disabled={locked || undefined} className="field mt-2" rows={3} maxLength={MAX_DEAL_NOTE} value={draft.note} onChange={(e) => put({ note: e.target.value })} />
              </label>
              {savedNow("note")}
            </div>
            {/* Always there, so a message put in it is announced (only its words change). */}
            <p className={error ? "notice notice-error mt-4" : "sr-only"} role="alert">
              {error ?? ""}
            </p>
            {/* Why the editor's controls are off now, beside them (they point here); not a live region. */}
            {why && (locked || writeUnconfirmed) ? <p id={EDITOR_WHY_ID} className="mt-4 text-sm font-semibold text-ink-soft">{why}</p> : null}
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" id={DEAL_SAVE_ID} className="btn btn-primary" {...offProps(locked || writeUnconfirmed, EDITOR_WHY_ID)} onClick={saveDeal}>
                {busy ? "Saving…" : "Save deal"}
              </button>
              <button type="button" id="deal-cancel" className="btn btn-secondary" {...offProps(locked, EDITOR_WHY_ID)} onClick={() => { if (!locked) closeDeal(); }}>
                Cancel
              </button>
            </div>
          </fieldset>
        ) : null}

        {/* An empty board says what it is for and how to start (487 [IT4], pattern 5). */}
        {pipelineDeals.length === 0 && draft === null ? (
          <p className="mt-6 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink-soft">
            {canChange ? <>No deals yet. When someone asks about something you sell outside a checkout, press &ldquo;New deal&rdquo; and move it across the stages as the talk goes on.</> : "No deals in this pipeline yet."}
          </p>
        ) : null}
        {view === "agenda" ? <DealAgenda deals={visibleDeals} stages={stages} currency={currency} today={today} disabled={paused} whyId={WHY_ID} onEdit={canChange ? deal => openDraft(deal, `deal-agenda-edit-${deal.id}`) : undefined} /> : (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {columns.map(({ stage, count, cents }) => (
            <section key={stage.id} aria-label={stage.name} className="min-w-0 rounded-2xl bg-paper p-4 ring-1 ring-line">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 id={`deal-column-${stage.id}`} tabIndex={-1} className="font-semibold text-ink">
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
                          <span className="sr-only">{pipelines.length > 1 ? `Stage of ${deal.title}, in any pipeline` : `Stage of ${deal.title}`}</span>
                          {/* Choosing a stage never moves the deal (3.2.2, 3.2.5): only "Move" does. Off while the board is paused, still focusable. */}
                          <select
                            id={`deal-stage-${deal.id}`}
                            className="field"
                            value={pendingMoves[deal.id] ?? deal.stage}
                            {...offProps(paused, WHY_ID, `deal-stage-hint-${deal.id}`)}
                            onChange={(e) => stageEvent(deal, { kind: "change", value: e.target.value })}
                          >
                            <StageOptions pipelines={editable} />
                          </select>
                        </label>
                        {/* Choosing only marks the stage; "Move" sends it (3.2.5), so arrowing through stages never moves the deal. */}
                        <button type="button" id={`deal-move-${deal.id}`} className="btn btn-primary btn-sm" {...offProps(paused || pendingMoves[deal.id] === undefined, [pendingMoves[deal.id] === undefined ? `deal-stage-hint-${deal.id}` : "", paused ? WHY_ID : ""].filter(Boolean).join(" "))} onClick={() => stageEvent(deal, { kind: "move" })} aria-label={`Move ${deal.title}`}>
                          Move
                        </button>
                        {/* Shown, and outside the label (so it is not part of the select's name): how to move, or the stage chosen; the status region says a stage chosen. */}
                        <p id={`deal-stage-hint-${deal.id}`} className="w-full text-xs text-ink-soft">{pendingMoves[deal.id] !== undefined ? stageChosenText(pendingMoves[deal.id], stageName) : MOVE_HINT}</p>
                        <button
                          type="button"
                          id={`deal-edit-${deal.id}`}
                          className="btn btn-secondary btn-sm"
                          {...offProps(paused, WHY_ID)}
                          onClick={() => { if (!paused) openDraft(deal, `deal-edit-${deal.id}`); }}
                        >
                          Edit
                        </button>
                        {/* Removing asks first (3.3.6): nothing is removed until "Remove deal" is pressed. */}
                        <button type="button" id={`deal-remove-${deal.id}`} className="btn btn-secondary btn-sm" {...offProps(paused, WHY_ID)} aria-expanded={confirmingId === deal.id} aria-controls={confirmingId === deal.id ? `deal-confirm-${deal.id}` : undefined} onClick={() => { if (paused) return; setError(null); setConfirming({ id: deal.id, stage: deal.stage }); moveFocus(`deal-confirm-${deal.id}`); }} aria-label={`Remove ${deal.title}`}>
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
                      {confirmingId === deal.id && canChange ? (
                        <div id={`deal-confirm-${deal.id}`} role="group" tabIndex={-1} aria-labelledby={`deal-confirm-${deal.id}-title`} aria-describedby={`deal-confirm-${deal.id}-text`} className="mt-3 rounded-xl bg-sand p-3" onKeyDown={e => { if (e.key === "Escape" && !locked) keepDeal(deal.id); }}>
                          <p id={`deal-confirm-${deal.id}-title`} className="font-semibold text-ink [overflow-wrap:anywhere]">{`Remove “${deal.title}”?`}</p>
                          <p id={`deal-confirm-${deal.id}-text`} className="mt-1 text-ink-soft">This deletes the deal and its note. You cannot get it back.</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {/* The safe choice first (3.3.6): Tab from the question reaches "Keep deal" before "Remove deal". */}
                            <button type="button" id={`deal-keep-${deal.id}`} className="btn btn-secondary btn-sm" {...offProps(locked, WHY_ID)} onClick={() => { if (!locked) keepDeal(deal.id); }}>
                              Keep deal
                            </button>
                            <button type="button" id={`deal-confirm-yes-${deal.id}`} className="btn btn-primary btn-sm" {...offProps(locked || writeUnconfirmed, WHY_ID)} onClick={() => removeDeal(deal)}>
                              {busy ? "Removing…" : "Remove deal"}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
        )}
        {/* Always there, so a message put in it is announced (only its words change). */}
        <p id="deal-board-alert" tabIndex={-1} className={error && !draft && !pipelineDraft && !fieldDraft ? "notice notice-error mt-4" : "sr-only"} role="alert">
          {error && !draft && !pipelineDraft && !fieldDraft ? error : ""}
        </p>
        {lost !== null && !draft ? (
          /* What the creator typed in a deal they can no longer change, to copy, never lost (3.3.7). */
          <div id={DEAL_HIDDEN_ID} role="group" tabIndex={-1} className="notice mt-4" aria-labelledby={`${DEAL_HIDDEN_ID}-title`}>
            <p id={`${DEAL_HIDDEN_ID}-title`} className="font-semibold">Here is what you typed, so you can copy it.</p>
            <label className="mt-3 block">
              <span className="field-label">What you typed</span>
              <textarea className="field mt-2" readOnly rows={Math.min(8, lost.split("\n").length + 1)} value={lost} />
            </label>
            <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => { setLost(null); setError(null); focusLater("deal-new", "deal-board-alert"); }}>
              Done
            </button>
          </div>
        ) : null}

        <div className="mt-6">
          {pipelineDraft ? (
            // Never disabled while saving, so the focused control keeps focus (2.4.3); a change typed meanwhile is not taken.
            <fieldset aria-busy={locked} className="min-w-0 rounded-2xl border border-line bg-white p-4 sm:p-6">
              <legend className="sr-only">{pipelineDraft.isNew ? "New pipeline" : "Pipeline and its stages"}</legend>
              <label className="block">
                <span className="field-label">{pipelineDraft.isNew ? "Name of the new pipeline" : "Pipeline name"}</span>
                <input id={PIPELINE_NAME_ID} {...badProps(PIPELINE_NAME_ID)} readOnly={locked} className="field mt-2" maxLength={MAX_PIPELINE_NAME} value={pipelineDraft.name} placeholder="Partnerships" onChange={e => { putPipeline({ ...pipelineDraft, name: e.target.value }); fixed(PIPELINE_NAME_ID); }} />
              </label>
              {errorBeside(PIPELINE_NAME_ID, "mt-2")}
              <p className="mt-4 font-semibold text-ink">Stages, in order</p>
              <ol className="mt-3 space-y-3">
                {pipelineDraft.stages.map((stage, i) => (
                  <li key={stage.id} className="flex flex-wrap items-center gap-2">
                    {/* A visible name of its own (487 [IT4], item 4). */}
                    {/* The whole line on a phone, so its name and field are never squeezed by the controls beside them. */}
                    <label className="flex min-w-0 basis-full items-center gap-2 sm:basis-0 sm:flex-1">
                      <span className="shrink-0 text-sm text-ink-soft">{`Stage ${i + 1}`}</span>
                      <input id={stageNameId(stage.id)} {...badProps(stageNameId(stage.id))} readOnly={locked} className="field min-w-0 flex-1" maxLength={MAX_STAGE_NAME} value={stage.name} onChange={(e) => { putPipeline({ ...pipelineDraft, stages: pipelineDraft.stages.map((s, j) => (j === i ? { ...s, name: e.target.value } : s)) }); fixed(stageNameId(stage.id)); }} />
                    </label>
                    {errorBeside(stageNameId(stage.id), "basis-full")}
                    <label className="flex items-center gap-2 text-sm text-ink-soft">
                      Counts as
                      <select className="field w-auto" aria-label={`Counts as, for stage ${i + 1}`} id={stageKindId(stage.id)} {...badProps(stageKindId(stage.id))} value={stage.kind} onChange={(e) => { putPipeline({ ...pipelineDraft, stages: pipelineDraft.stages.map((s, j) => (j === i ? { ...s, kind: e.target.value as StageKind } : s)) }); fixed(stageKindId(stage.id)); }}>
                        <option value="open">Open</option>
                        <option value="won">Won</option>
                        <option value="lost">Lost</option>
                      </select>
                    </label>
                    {errorBeside(stageKindId(stage.id), "basis-full")}
                    {/* At the top or the bottom, Up or Down stays focusable and says why it does nothing (2.4.3); after a move, focus stays on it. */}
                    <button type="button" id={`stage-up-${stage.id}`} className="btn btn-secondary btn-sm" {...offProps(i === 0 || locked, i === 0 ? STAGE_EDGES_ID : EDITOR_WHY_ID)} onClick={() => { if (i === 0 || locked) return; moveStage(i, i - 1); moveFocus(`stage-up-${stage.id}`); }} aria-label={`Move stage ${i + 1} up`}>Up</button>
                    <button type="button" id={`stage-down-${stage.id}`} className="btn btn-secondary btn-sm" {...offProps(i === pipelineDraft.stages.length - 1 || locked, i === pipelineDraft.stages.length - 1 ? STAGE_EDGES_ID : EDITOR_WHY_ID)} onClick={() => { if (i === pipelineDraft.stages.length - 1 || locked) return; moveStage(i, i + 1); moveFocus(`stage-down-${stage.id}`); }} aria-label={`Move stage ${i + 1} down`}>Down</button>
                    {/* Focus goes to the next stage's name, else the one before, else "Add a stage" (2.4.3). */}
                    <button type="button" className="btn btn-secondary btn-sm" {...offProps(locked, EDITOR_WHY_ID)} onClick={() => { if (locked) return; const neighbor = neighborAfterRemoval(pipelineDraft.stages.map(s => s.id), stage.id); setPipelineDraft({ ...pipelineDraft, stages: pipelineDraft.stages.filter((_, j) => j !== i) }); fixed(stageNameId(stage.id), stageKindId(stage.id)); moveFocus(neighbor ? stageNameId(neighbor) : "stage-add"); }} aria-label={`Remove stage ${i + 1}`}>
                      <Icon name="minus" size={16} />
                    </button>
                  </li>
                ))}
              </ol>
              {pipelineDraft.stages.length < MAX_STAGES ? (
                <button type="button" id="stage-add" className="btn btn-secondary btn-sm mt-3" {...offProps(locked, EDITOR_WHY_ID)} onClick={() => { if (locked) return; const id = newCrmId(); setPipelineDraft({ ...pipelineDraft, stages: [...pipelineDraft.stages, { id, name: "", kind: "open" }] }); moveFocus(stageNameId(id)); }}>
                  <Icon name="plus" size={16} />
                  Add a stage
                </button>
              ) : null}
              <p className="mt-3 text-xs text-ink-soft">{`Up to ${MAX_STAGES} stages, with at least one open, one won and one lost.`}</p>
              <p id={STAGE_EDGES_ID} className="mt-1 text-xs text-ink-soft">The first stage cannot move up, and the last cannot move down.</p>
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
                      <div key={s.id}>
                        <label className="block">
                          <span className="field-label">{`${s.name}: ${dealsIn(s.id)} ${dealsIn(s.id) === 1 ? "deal" : "deals"} go to`}</span>
                          <select id={stageMovesId(s.id)} {...badProps(stageMovesId(s.id))} className="field mt-2" value={pipelineDraft.moves[s.id] ?? ""} onChange={e => { putPipeline({ ...pipelineDraft, moves: { ...pipelineDraft.moves, [s.id]: e.target.value } }); fixed(stageMovesId(s.id)); }}>
                            <option value="">Choose a stage</option>
                            <StageOptions pipelines={targets} />
                          </select>
                        </label>
                        {errorBeside(stageMovesId(s.id), "mt-2")}
                      </div>
                    ))}
                    <p className="text-xs text-ink-soft">Moving them this way starts no workflow.</p>
                  </div>
                );
              })()}
              {/* Why the editor's controls are off now, beside them (they point here); not a live region. */}
              {why && (locked || writeUnconfirmed) ? <p id={EDITOR_WHY_ID} className="mt-4 text-sm font-semibold text-ink-soft">{why}</p> : null}
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" id="pipeline-save" className="btn btn-primary" {...offProps(locked || writeUnconfirmed, EDITOR_WHY_ID)} onClick={savePipeline}>
                  {pipelineDraft.isNew ? "Add pipeline" : "Save pipeline"}
                </button>
                <button type="button" id="pipeline-cancel" className="btn btn-secondary" {...offProps(locked, EDITOR_WHY_ID)} onClick={() => { if (!locked) closePipeline(); }}>
                  Cancel
                </button>
              </div>
              {!pipelineDraft.isNew && pipelines.length > 1 ? (
                <div className="mt-6 space-y-3 border-t border-line pt-4">
                  <p className="text-sm font-semibold text-ink">{`Remove ${pipeline.name}`}</p>
                  {pipelineDeals.length ? (
                    <div>
                      <label className="block">
                        <span className="field-label">{`Its ${pipelineDeals.length} ${pipelineDeals.length === 1 ? "deal goes" : "deals go"} to`}</span>
                        <select id={PIPELINE_REMOVE_TO_ID} {...badProps(PIPELINE_REMOVE_TO_ID)} className="field mt-2" value={pipelineDraft.removeTo} onChange={e => { putPipeline({ ...pipelineDraft, removeTo: e.target.value }); fixed(PIPELINE_REMOVE_TO_ID); }}>
                          <option value="">Choose a stage of another pipeline</option>
                          <StageOptions pipelines={editable.filter(p => p.id !== pipeline.id)} />
                        </select>
                      </label>
                      {errorBeside(PIPELINE_REMOVE_TO_ID, "mt-2")}
                    </div>
                  ) : <p className="text-sm text-ink-soft">It holds no deals.</p>}
                  {/* Never off for a missing choice: pressing it says, beside the choice, what to choose (3.3.1). */}
                  <button type="button" id="pipeline-remove" className="btn btn-secondary" {...offProps(locked || writeUnconfirmed, EDITOR_WHY_ID)} onClick={removePipeline}>
                    Remove this pipeline
                  </button>
                </div>
              ) : null}
              {/* Always there, so a message put in it is announced; an error about one control is said beside it instead. */}
              <p className={error ? "notice notice-error mt-4" : "sr-only"} role="alert">{error ?? ""}</p>
            </fieldset>
          ) : canChange ? (
            <button type="button" id="pipeline-change" className="btn btn-secondary btn-sm" {...offProps(paused, WHY_ID)} onClick={() => { if (!paused) openPipeline({ id: pipeline.id, name: pipeline.name, stages: structuredClone(pipeline.stages), isNew: false, moves: {}, removeTo: "" }, "pipeline-change"); }}>
              {pipelines.length > 1 ? `Change ${pipeline.name} and its stages` : "Change the pipeline and its stages"}
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
          // Never disabled while saving, so the focused control keeps focus (2.4.3); a change typed meanwhile is not taken.
          <fieldset aria-busy={locked} aria-labelledby="crm-fields-title" className="min-w-0 mt-6 rounded-2xl border border-line bg-white p-4 sm:p-6">
            {/* Named by its visible heading, "Your fields", rather than a name only a screen reader hears. */}
            <ol className="space-y-3">
              {fieldDraft.map((field, i) => (
                <li key={field.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
                  <label className="block min-w-0">
                    <span className="text-sm text-ink-soft">{`Field ${i + 1}`}</span>
                    <input id={crmFieldNameId(field.id)} {...badProps(crmFieldNameId(field.id))} readOnly={locked} className="field mt-1" maxLength={MAX_FIELD_NAME} placeholder="Company" value={field.name} onChange={(e) => { putFields(fieldDraft.map((f, j) => (j === i ? { ...f, name: e.target.value } : f))); fixed(crmFieldNameId(field.id)); }} />
                  </label>
                  <label className="block min-w-0">
                    <span className="text-sm text-ink-soft">Kind</span>
                    <select className="field mt-1" aria-label={`Kind of field ${i + 1}`} aria-disabled={locked || undefined} aria-describedby={locked ? EDITOR_WHY_ID : undefined} value={field.type} onChange={(e) => { const type = e.target.value as FieldType; putFields(fieldDraft.map((f, j) => (j === i ? { ...f, type } : f))); if (!hasChoices(type)) fixed(crmFieldChoicesId(field.id)); }}>
                      {FIELD_TYPES.map((t) => (
                        <option key={t.type} value={t.type}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {/* Focus goes to the next field's name, else the one before, else "Add a field" (2.4.3). */}
                  <button type="button" className="btn btn-secondary btn-sm" {...offProps(locked, EDITOR_WHY_ID)} onClick={() => { if (locked) return; const neighbor = neighborAfterRemoval(fieldDraft.map(f => f.id), field.id); setFieldDraft(fieldDraft.filter((_, j) => j !== i)); fixed(crmFieldNameId(field.id), crmFieldChoicesId(field.id)); moveFocus(neighbor ? crmFieldNameId(neighbor) : "crm-field-add"); }} aria-label={`Remove field ${i + 1}`}>
                    <Icon name="minus" size={16} />
                  </button>
                  {errorBeside(crmFieldNameId(field.id), "sm:col-span-3")}
                  {hasChoices(field.type) ? (
                    <label className="block min-w-0 sm:col-span-3">
                      <span className="text-sm text-ink-soft">Choices, separated by commas</span>
                      <input
                        id={crmFieldChoicesId(field.id)}
                        {...badProps(crmFieldChoicesId(field.id))}
                        readOnly={locked}
                        className="field mt-1"
                        aria-label={`Choices, separated by commas, for field ${i + 1}`}
                        placeholder="Coaching, Course, Not sure yet"
                        value={field.optionsText}
                        onChange={(e) => { putFields(fieldDraft.map((f, j) => (j === i ? { ...f, optionsText: e.target.value } : f))); fixed(crmFieldChoicesId(field.id)); }}
                      />
                    </label>
                  ) : null}
                  {errorBeside(crmFieldChoicesId(field.id), "sm:col-span-3")}
                </li>
              ))}
            </ol>
            {fieldDraft.length < MAX_CRM_FIELDS ? (
              <button type="button" id="crm-field-add" className="btn btn-secondary btn-sm mt-3" {...offProps(locked, EDITOR_WHY_ID)} onClick={() => { if (locked) return; const id = newCrmId(); setFieldDraft([...fieldDraft, { id, name: "", type: "text", options: [], optionsText: "" }]); moveFocus(crmFieldNameId(id)); }}>
                <Icon name="plus" size={16} />
                Add a field
              </button>
            ) : null}
            {/* Why the editor's controls are off now, beside them (they point here); not a live region. */}
            {why && (locked || writeUnconfirmed) ? <p id={EDITOR_WHY_ID} className="mt-4 text-sm font-semibold text-ink-soft">{why}</p> : null}
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                id="crm-fields-save"
                className="btn btn-primary"
                {...offProps(locked || writeUnconfirmed, EDITOR_WHY_ID)}
                onClick={saveFields}
              >
                Save fields
              </button>
              <button type="button" id="crm-fields-cancel" className="btn btn-secondary" {...offProps(locked, EDITOR_WHY_ID)} onClick={() => { if (!locked) closeFields(); }}>
                Cancel
              </button>
            </div>
            {/* Always there, so a message put in it is announced; an error about one control is said beside it instead. */}
            <p className={error ? "notice notice-error mt-4" : "sr-only"} role="alert">{error ?? ""}</p>
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
            <button type="button" id="crm-fields-change" className="btn btn-secondary btn-sm mt-4" {...offProps(paused, WHY_ID)} onClick={() => { if (!paused) openFields(); }}>
              {fields.length ? "Change the fields" : "Add your first field"}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
