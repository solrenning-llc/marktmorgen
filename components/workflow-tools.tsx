"use client";

/**
 * The workflow pieces of the Email studio (added 17 October 2026): the map of
 * where each step leads, the preview of one person's path before switching a
 * workflow on, and each run's history with the choices for a held run.
 * Nothing here sends or changes anything except the explicit buttons, which
 * go through the studio's own request (`request`).
 */
import { useEffect, useState } from "react";
import { type FlowAction, type FlowGoal, type StepCondition, isCourseIf } from "@/lib/flow-rules";
import { END, type RoutedStep, type SampleContact, previewRun } from "@/lib/flow-paths";
import type { RunEvent, RunRecord } from "@/lib/flow-runs";
import { MAX_RETRIES_BY_YOU, MAX_RUN_EVENTS } from "@/lib/flow-limits";
import { runEffects } from "@/lib/run-effects";
import { stopRules } from "@/lib/flow-stop-rules";

type Answer = Record<string, unknown> & { ok?: boolean; error?: string };
type Request = (payload: Record<string, unknown>) => Promise<Answer>;
type Product = { id: string; title: string };

export type MapStep = RoutedStep & { subject?: string };

const n = (x: number) => x.toLocaleString("en-US");
const TIME: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const when = (seconds: number) => (seconds > 0 ? new Date(seconds * 1000).toLocaleString("en-US", TIME) : "—");

/** "Step 3" for a step index; "the end" for -1. */
export const stepName = (index: number) => (index < 0 ? "the end" : `step ${index + 1}`);

/** What one step does, in a few words, for the map and the preview. */
export function stepWhat(step: MapStep): string {
  const action: FlowAction | undefined = step.action;
  if (!action) return step.subject ? `Email “${step.subject}”` : "Email";
  switch (action.do) {
    case "tag":
      return `Give the label “${action.tag}”`;
    case "untag":
      return `Take off the label “${action.tag}”`;
    case "stop":
      return "Take them out of another workflow";
    case "start":
      return "Start another workflow";
    case "webhook":
      return "Tell your webhooks";
    case "field":
      return "Set a field";
    case "deal":
      return "Move their deal to a stage";
    case "note":
      return "Write a note on their page";
    case "notify":
      return "Email you who reached it";
    case "wait":
      return "Wait";
    case "assign":
      return `Make ${action.assignee} responsible for their deal`;
    case "rotate":
      return "Give their deal to whoever on your team has the fewest open deals";
    case "next":
      return `Set the next action on their deal: “${action.text}”, ${action.days === 0 ? "due the day it runs" : `due in ${action.days} ${action.days === 1 ? "day" : "days"}`}`;
  }
}

/** Where a step sends people, as one line: "Then step 5" or "If not: the end". */
export function routeWords(steps: readonly MapStep[], index: number): string {
  const step = steps[index];
  const indexOf = (id: string | undefined) => (id === undefined ? -2 : steps.findIndex((s) => s.id === id));
  const after = step.next === END ? -1 : step.next ? indexOf(step.next) : index + 1 < steps.length ? index + 1 : -1;
  const then = `then ${stepName(after)}`;
  if (!step.when) return then;
  const otherwise = step.otherwise === "end" ? -1 : step.otherwise === "jump" ? indexOf(step.jump) : index + 1 < steps.length ? index + 1 : -1;
  return `if yes, ${then}; if not, ${stepName(otherwise)}`;
}

/** The map of a workflow: every step with what it does and where it leads. */
export function WorkflowMap({ steps, conditionText }: { steps: readonly MapStep[]; conditionText: (when: StepCondition) => string }) {
  return (
    <ol className="mt-2 space-y-1 text-sm text-ink-soft" data-workflow-map>
      {steps.map((step, i) => (
        <li key={step.id} className="flex flex-wrap gap-x-2">
          <span className="font-semibold text-ink">{`${i + 1}.`}</span>
          <span>{`${step.when ? `If ${conditionText(step.when)}: ` : ""}${stepWhat(step)}`}</span>
          <span aria-hidden="true">→</span>
          <span>{routeWords(steps, i)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The products and courses a workflow's conditions and goal read, so the sample asks only about those. */
function referenced(steps: readonly MapStep[], goal: FlowGoal | null | undefined): { products: Set<string>; courses: Set<string>; tags: Set<string>; clicks: boolean; buyer: boolean; halves: boolean } {
  const products = new Set<string>();
  const courses = new Set<string>();
  const tags = new Set<string>();
  let clicks = false;
  let buyer = false;
  let halves = false;
  for (const step of steps) {
    const c = step.when;
    if (c && "productId" in c) (isCourseIf(c.if) ? courses : products).add(c.productId);
    if (c && "tag" in c) tags.add(c.tag);
    if (c?.if === "clicked" || c?.if === "unclicked") clicks = true;
    if (c?.if === "buyer" || c?.if === "lead") buyer = true;
    if (c?.if === "half-a" || c?.if === "half-b") halves = true;
  }
  if (goal && "productId" in goal) products.add(goal.productId);
  if (goal && "any" in goal) buyer = true;
  if (goal && "tag" in goal) tags.add(goal.tag);
  return { products, courses, tags, clicks, buyer, halves };
}

/**
 * Which path a sample person would take, decided by the same functions the
 * scheduled job uses (lib/flow-paths.ts). The sample is typed in, or read
 * from one person on the list; nothing is sent and nothing is saved.
 */
export function WorkflowPreview({
  flowId,
  steps,
  goal,
  products,
  paidProducts,
  request,
  conditionText,
  confirm,
}: {
  flowId: string;
  steps: readonly MapStep[];
  goal: FlowGoal | null | undefined;
  products: readonly Product[];
  paidProducts: readonly string[];
  /** Reads one person of the list; omitted where that is not allowed. */
  request?: Request;
  conditionText: (when: StepCondition) => string;
  /** A button under the preview, for switching the workflow on once it has been read. */
  confirm?: { label: string; busy: boolean; onConfirm: () => void; onCancel: () => void };
}) {
  const refs = referenced(steps, goal);
  const [sample, setSample] = useState<SampleContact>({ ids: [], buyer: false, tags: [], clicks: false, courses: {}, half: "a" });
  const [tagText, setTagText] = useState("");
  const [lookup, setLookup] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const title = (id: string) => products.find((p) => p.id === id)?.title ?? "a product no longer in your store";
  const current: SampleContact = { ...sample, tags: tagText.split(",").map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 10) };
  const result = previewRun({ id: flowId || "preview", steps, goal }, current, new Set(paidProducts));

  async function load() {
    if (!request || !lookup.trim()) return;
    setLooking(true);
    setStatus(null);
    const a = await request({ action: "flow-sample", email: lookup.trim(), courses: [...refs.courses] });
    setLooking(false);
    if (!a.ok) return setStatus("That person could not be read just now. Try again in a moment.");
    if (a.found !== true || !a.sample || typeof a.sample !== "object") return setStatus("Nobody with that address is on your list.");
    const s = a.sample as SampleContact;
    setSample({ email: s.email, ids: Array.isArray(s.ids) ? s.ids : [], buyer: s.buyer === true, tags: [], clicks: sample.clicks, courses: s.courses ?? {}, half: sample.half });
    setTagText((Array.isArray(s.tags) ? s.tags : []).join(", "));
    setStatus(`Loaded from your list. Whether they would use a link is not known: set it below.`);
  }

  const toggle = (id: string, on: boolean) => setSample({ ...sample, ids: on ? [...new Set([...sample.ids, id])] : sample.ids.filter((x) => x !== id) });

  return (
    <div className="rounded-[var(--r-sm)] border border-line bg-white p-4" data-workflow-preview>
      <p className="font-semibold text-ink">Preview a path</p>
      <p className="mt-1 text-sm text-ink-soft">
        Describe someone, and see which steps they would get. The same facts always give the same path. Nothing is sent or saved.
      </p>
      {request ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block min-w-0 grow basis-56">
            <span className="text-sm text-ink-soft">Or start from someone on your list</span>
            <input className="field mt-1" type="email" autoComplete="off" value={lookup} placeholder="name@example.com" onChange={(e) => setLookup(e.target.value)} />
          </label>
          <button type="button" className="btn btn-secondary btn-sm" disabled={looking || !lookup.trim()} aria-busy={looking} onClick={load}>
            {looking ? "Reading…" : "Use this person"}
          </button>
        </div>
      ) : null}
      {status ? <p role="status" className="mt-2 text-sm text-ink-soft">{status}</p> : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {[...refs.products].map((id) => (
          <label key={id} className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={sample.ids.includes(id)} onChange={(e) => toggle(id, e.target.checked)} />
            <span>{`Has ${title(id)}`}</span>
          </label>
        ))}
        {refs.buyer ? (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={sample.buyer} onChange={(e) => setSample({ ...sample, buyer: e.target.checked })} />
            <span>Has bought something</span>
          </label>
        ) : null}
        {refs.clicks ? (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={sample.clicks} onChange={(e) => setSample({ ...sample, clicks: e.target.checked })} />
            <span>Uses a link in each email they get</span>
          </label>
        ) : null}
        {[...refs.courses].map((id) => (
          <div key={id} className="flex flex-wrap gap-3 text-sm text-ink">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={sample.courses[id]?.started === true}
                onChange={(e) => setSample({ ...sample, courses: { ...sample.courses, [id]: { started: e.target.checked, finished: e.target.checked && sample.courses[id]?.finished === true } } })}
              />
              <span>{`Opened ${title(id)}`}</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={sample.courses[id]?.finished === true}
                onChange={(e) => setSample({ ...sample, courses: { ...sample.courses, [id]: { started: e.target.checked || sample.courses[id]?.started === true, finished: e.target.checked } } })}
              />
              <span>Finished it</span>
            </label>
          </div>
        ))}
        {refs.halves && !sample.email ? (
          <label className="block text-sm text-ink">
            <span className="text-ink-soft">Their half of the A/B split</span>
            <select className="field mt-1" value={sample.half ?? "a"} onChange={(e) => setSample({ ...sample, half: e.target.value === "b" ? "b" : "a" })}>
              <option value="a">First half (A)</option>
              <option value="b">Second half (B)</option>
            </select>
          </label>
        ) : null}
        <label className="block text-sm sm:col-span-2">
          <span className="text-ink-soft">{refs.tags.size ? `Their labels, separated by commas (this workflow reads: ${[...refs.tags].join(", ")})` : "Their labels, separated by commas"}</span>
          <input className="field mt-1" value={tagText} onChange={(e) => setTagText(e.target.value)} />
        </label>
      </div>
      <ol className="mt-4 space-y-1 text-sm" data-preview-path>
        {result.path.map((p) => (
          <li key={p.stepId} className="text-ink">
            <span className="font-semibold">{`Step ${p.index + 1}: `}</span>
            {p.outcome === "runs" ? stepWhat(steps[p.index]) : `Skipped: ${steps[p.index].when ? conditionText(steps[p.index].when!) : "condition"} does not hold`}
            <span className="text-ink-soft">{` → ${stepName(p.to)}`}</span>
          </li>
        ))}
        <li className="font-semibold text-ink" data-preview-end>
          {result.end === "goal"
            ? `Ends: the goal is reached before step ${(result.goalBefore ?? 0) + 1}.`
            : result.end === "condition"
              ? "Ends: a condition ends the run there."
              : result.path.length
                ? "Ends: every step on this path is done."
                : "Ends at once: there are no steps."}
        </li>
      </ol>
      <p className="mt-2 text-xs text-ink-soft">
        {`${n(result.path.filter((p) => p.outcome === "runs" && !steps[p.index].action).length)} emails on this path. A purchase or a click in the middle of a real run can change it; the goal is checked before every step.`}
      </p>
      <div className="mt-3 text-sm" data-stop-rules>
        <p className="font-semibold text-ink">When a run stops</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-soft">
          {stopRules({ steps, goal }, { condition: conditionText, product: title }).map((rule, i) => (
            <li key={i}>{rule.text}</li>
          ))}
        </ul>
      </div>
      {confirm ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary btn-sm" disabled={confirm.busy} aria-busy={confirm.busy} onClick={confirm.onConfirm}>{confirm.label}</button>
          <button type="button" className="text-sm font-bold text-ink-soft underline underline-offset-4" onClick={confirm.onCancel}>Not now</button>
        </div>
      ) : null}
    </div>
  );
}

const RUN_STATUS_WORDS: Record<string, string> = {
  running: "In progress",
  waiting: "Waiting",
  held: "Held: needs you",
  done: "Finished",
  goal: "Reached the goal",
  ended: "Ended",
  left: "Left your list",
  failed: "Failed",
};
const EVENT_WORDS: Record<string, string> = {
  started: "Started",
  attempted: "Attempted",
  confirmed: "Confirmed",
  failed: "Failed",
  uncertain: "Uncertain",
  skipped: "Skipped",
  goal: "Goal reached",
  ended: "Ended",
  resolved: "Your choice",
};
const EVENT_CLASS: Record<string, string> = {
  confirmed: "tag tag-live",
  failed: "tag text-danger",
  uncertain: "tag tag-next",
  resolved: "tag tag-brand",
};

const RUN_ERRORS: Record<string, string> = {
  flow_runs_unavailable: "Run history could not be read just now. This does not mean there are no runs. Try again in a moment.",
  run_not_held: "This run is not held any more: somebody already chose what to do with it. Reload its history.",
  run_paused: "Switch the workflow on first: a paused workflow sends nothing, so continuing would only end the run.",
  unknown: "That run is not there any more. Reload the page.",
  flow_write_unconfirmed: "Your choice could not be confirmed. Reload this run's history before choosing again.",
  run_retry_limit: `This run has been tried again ${MAX_RETRIES_BY_YOU} times, the most one run may. Choose whether it went through, or end it.`,
};

/**
 * One run's effects counted four ways, kept apart (lib/run-effects.ts): an
 * effect nobody confirmed is uncertain, never done, even once you chose to
 * continue past it.
 */
function RunEffectCounts({ events }: { events: readonly RunEvent[] }) {
  const { counts, markedByYou, trimmed, effects } = runEffects(events);
  const waiting = effects.filter((e) => e.waiting).length;
  return (
    <div className="mt-3 text-sm" data-run-effects>
      <p className="flex flex-wrap gap-2">
        <span className="tag">{`Attempted ${n(counts.attempted)}`}</span>
        <span className="tag tag-live">{`Confirmed ${n(counts.confirmed)}`}</span>
        <span className="tag text-danger">{`Failed ${n(counts.failed)}`}</span>
        <span className="tag tag-next">{`Uncertain ${n(counts.uncertain)}`}</span>
      </p>
      {waiting ? <p className="mt-1 text-ink-soft">{`${n(waiting)} of them ${waiting === 1 ? "has" : "have"} no outcome written yet, so ${waiting === 1 ? "it is" : "they are"} counted as uncertain, not done.`}</p> : null}
      {markedByYou ? <p className="mt-1 text-ink-soft">{`You marked ${n(markedByYou)} uncertain ${markedByYou === 1 ? "step" : "steps"} as gone through. ${markedByYou === 1 ? "It stays" : "They stay"} counted as uncertain: the outcome was never confirmed.`}</p> : null}
      {trimmed ? <p className="mt-1 text-ink-soft">{`A run keeps its latest ${n(MAX_RUN_EVENTS)} events; its earliest ones are no longer kept, and the counts are of what is.`}</p> : null}
    </div>
  );
}

/** A workflow's runs, newest first, and one run's history step by step. */
export function WorkflowRuns({ flowId, steps, request }: { flowId: string; steps: readonly MapStep[]; request: Request }) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ run: RunRecord; events: RunEvent[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    request({ action: "flow-runs", id: flowId }).then((a) => {
      if (!live) return;
      if (a.ok && Array.isArray(a.runs)) setRuns(a.runs as RunRecord[]);
      else setError(RUN_ERRORS[a.error ?? ""] ?? RUN_ERRORS.flow_runs_unavailable);
    });
    return () => {
      live = false;
    };
  }, [flowId, request]);

  async function show(person: string) {
    setBusy(true);
    setError(null);
    const a = await request({ action: "flow-run", id: flowId, run: person });
    setBusy(false);
    if (a.ok && a.run && Array.isArray(a.events)) setOpen({ run: a.run as RunRecord, events: a.events as RunEvent[] });
    else setError(RUN_ERRORS[a.error ?? ""] ?? RUN_ERRORS.flow_runs_unavailable);
  }

  async function erasePerson() {
    if (!open) return;
    setBusy(true);
    setError(null);
    const a = await request({ action: "flow-forget", email: open.run.email });
    setBusy(false);
    if (!a.ok) return setError(RUN_ERRORS[a.error ?? ""] ?? "The erasure could not be confirmed. Try again in a moment.");
    const gone = open.run.person;
    setOpen(null);
    setRuns((list) => list?.filter((r) => r.person !== gone) ?? list);
  }

  async function resolve(choice: "continue" | "retry" | "end") {
    if (!open) return;
    setBusy(true);
    setError(null);
    const a = await request({ action: "flow-resolve", id: flowId, run: open.run.person, choice });
    setBusy(false);
    if (a.ok && a.run && Array.isArray(a.events)) {
      const run = a.run as RunRecord;
      setOpen({ run, events: a.events as RunEvent[] });
      setRuns((list) => list?.map((r) => (r.person === run.person ? run : r)) ?? list);
    } else setError(RUN_ERRORS[a.error ?? ""] ?? RUN_ERRORS.flow_runs_unavailable);
  }

  const label = (index: number, stepId: string) => {
    const at = steps.findIndex((s) => s.id === stepId);
    return index < 0 ? "Run" : `Step ${(at >= 0 ? at : index) + 1}${at >= 0 ? ` · ${stepWhat(steps[at])}` : " · a step since removed"}`;
  };

  return (
    <div className="mt-3 rounded-[var(--r-sm)] bg-sand p-4" data-workflow-runs>
      <p className="font-semibold text-ink">Runs</p>
      <p className="mt-1 text-sm text-ink-soft">
        Each person&apos;s way through this workflow, newest first. Every step is written down as attempted before it happens, then confirmed, failed or
        uncertain. An uncertain step is never repeated by itself: the run is held until you choose.
      </p>
      {error ? <p role="status" className="mt-2 text-sm text-danger">{error}</p> : null}
      {runs === null && !error ? <p role="status" className="mt-2 text-sm text-ink-soft">Reading runs…</p> : null}
      {runs && !runs.length ? <p className="mt-2 text-sm text-ink-soft">Nobody has started this workflow since run history began.</p> : null}
      {runs && runs.length ? (
        <ul className="mt-3 divide-y divide-line">
          {runs.map((r) => (
            <li key={r.person} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0 break-all text-ink">{r.email || "An address no longer kept"}</span>
              <span className="flex flex-wrap items-center gap-2">
                <span className={r.status === "held" ? "tag tag-next" : "tag"}>{RUN_STATUS_WORDS[r.status] ?? r.status}</span>
                <span className="text-ink-soft">{when(r.updatedAt)}</span>
                <button type="button" className="font-bold text-ink-soft underline underline-offset-4" disabled={busy} onClick={() => show(r.person)}>History</button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <div className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4" data-run-history>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="min-w-0 break-all font-semibold text-ink">{open.run.email}</p>
            <span className={open.run.status === "held" ? "tag tag-next" : "tag"}>{RUN_STATUS_WORDS[open.run.status] ?? open.run.status}</span>
          </div>
          <p className="mt-1 text-sm text-ink-soft">{`Started ${when(open.run.startedAt)}${open.run.note ? ` · ${open.run.note}` : ""}`}</p>
          <RunEffectCounts events={open.events} />
          <ol className="mt-3 space-y-2 text-sm">
            {open.events.map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <span className={EVENT_CLASS[e.state] ?? "tag"}>{EVENT_WORDS[e.state] ?? e.state}</span>
                <span className="text-ink">{label(e.step, e.stepId)}</span>
                <span className="text-ink-soft">{when(e.at)}</span>
                {e.note ? <span className="basis-full text-ink-soft">{e.note}</span> : null}
              </li>
            ))}
          </ol>
          {open.run.email ? (
            <p className="mt-3 text-sm text-ink-soft">
              Asked to be deleted?{" "}
              <button type="button" className="font-bold underline underline-offset-4 hover:text-danger" disabled={busy} onClick={erasePerson}>
                Erase {open.run.email} from every workflow
              </button>
              : their runs, history and waiting steps in all your workflows. This does not remove their address from your list itself.
            </p>
          ) : null}
          {open.run.status === "held" ? (
            <div className="notice notice-warn mt-3 text-sm">
              <p className="font-semibold">What should happen with this step?</p>
              <p className="mt-1">Its outcome could not be confirmed, so it was not repeated. Check what you can (the person&apos;s inbox, their page, your deals board), then choose.</p>
              <p className="mt-1">{open.run.retries >= MAX_RETRIES_BY_YOU ? `It has been tried again ${n(MAX_RETRIES_BY_YOU)} times, the most one run may: choose whether it went through, or end it.` : `A run may be tried again up to ${n(MAX_RETRIES_BY_YOU)} times; this one has been tried again ${n(open.run.retries)} ${open.run.retries === 1 ? "time" : "times"}.`}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => resolve("continue")}>It went through: continue</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy || open.run.retries >= MAX_RETRIES_BY_YOU} onClick={() => resolve("retry")}>Try it again (may arrive twice)</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => resolve("end")}>End this run</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
