"use client";

import { useContext, useEffect, useId, useRef, useState } from "react";
import { AI_ALLOWANCE_UNKNOWN, AiOn, allowanceOf } from "@/components/ai-assist";
import { AiDraftReview } from "@/components/ai-draft-review";
import { AiStepsProgress, type StepView } from "@/components/ai-steps-assist";
import { Icon } from "@/components/icons";
import { MAX_AI_NOTES } from "@/lib/ai-rules";
import { readAiAnswer } from "@/lib/ai-response";
import { type AiStepId, type AiStepLine, readStepLine } from "@/lib/ai-steps";
import { aiDraftHold, draftStrings, freshChecks, reviewDone, sensitiveTopics, unsourcedNumbers } from "@/lib/ai-draft-review";
import {
  MAX_FILE_SECTIONS,
  MAX_FILE_TITLE,
  MAX_SECTION_CHARS,
  MAX_SECTION_POINT,
  MAX_SECTION_TITLE,
  SECTION_POINTS,
  type FileDraft,
  type FileOutline,
  cleanSectionBody,
  fileJobs,
  filePages,
  fileSteps,
  fileTexts,
  parseOutline,
  readFileDraft,
} from "@/lib/ai-file-rules";

/**
 * "Write this product's file with AI" (758 [STN5], unit 3): a plan first,
 * which the creator changes; then the parts, step by step, with Stop; then
 * the text under the "AI draft" checks of 756 [STN3]; and only then a tagged
 * PDF kept as the file of this draft product. It never publishes anything.
 *
 * Accessibility (AX274): every box has a visible label; the steps are said in
 * a polite region (AiStepsProgress); each stage moves focus to its own
 * heading; errors are alerts; every button is at least 44 by 44 pixels; no
 * time limit; nothing moves.
 */

const MESSAGES: Record<string, string> = {
  notes: "Write a few words first: what the guide is about and who it is for.",
  used: "This month's writing help is used up. It starts again with your next billing month.",
  slow: "A few at a time: wait a minute, then try again.",
  failed: "The writing help did not answer just now. Started attempts count toward the monthly allowance. Try again in a moment.",
  off: "Writing a file with AI is not available right now.",
  forbidden: "Your role on this store cannot do this.",
  published: "This works only on a draft product. Unpublish it first, or start a new product.",
  has_file: "This product already hands over a file or a link.",
  kind: "This works only on a product that hands over a file.",
  long: "The plan is too long to send. Make some part names or points shorter.",
  unchecked: "Check the three boxes under the draft first.",
  expired: "This text can no longer be made into a file. Write the parts again to make one.",
  letters: "Some letters in the text cannot be drawn in the PDF. Change them, then try again.",
  too_big: "The file came out too big to keep. Write the parts again with less text to make one.",
  storage_full: "Your storage is full. Delete a file you do not need, then try again.",
  upload_budget_unavailable: "Files cannot be added just now. Try again later.",
  changed: "A file was added to this product meanwhile. That file was kept.",
  unconfirmed: "We could not confirm what happened. Reload the page to check.",
};
const said = (error: string) => MESSAGES[error] ?? MESSAGES.unconfirmed;
/** A save that failed after its PDF was drawn spends the run's one save (lib/ai-file.ts, saveGivenBack): said so, not "try again". */
const SAVE_FAILED = "The file could not be kept just now. Nothing was added to the product. Write the parts again to make one.";

/** After a run ends: a part that started and did not come back, and a part never started, said apart. */
export function finalStates(ids: readonly AiStepId[], states: Partial<Record<AiStepId, StepView>>): Partial<Record<AiStepId, StepView>> {
  return Object.fromEntries(ids.map((id) => [id, states[id] === "done" ? "done" : states[id] === "running" ? "unfinished" : "skipped"]));
}

/** The checked text and its save: drawn by AiFileAssist, kept apart so it can be checked as drawn. */
export function AiFileReview({
  draft,
  given,
  checks,
  missing,
  saving,
  onToggle,
  onEdit,
  onSave,
}: {
  draft: FileDraft;
  /** What the creator typed, so a number they gave is not marked as an estimate. */
  given: string;
  checks: readonly boolean[];
  missing: readonly string[];
  saving: boolean;
  onToggle: (index: number, ticked: boolean) => void;
  onEdit: (index: number, body: string) => void;
  onSave: () => void;
}) {
  const base = useId();
  const texts = fileTexts(draft);
  const hold = aiDraftHold([...checks]);
  return (
    <div className="space-y-3">
      {missing.length ? (
        <p className="text-sm text-ink">{`These parts did not come back and are not in the file: ${missing.join("; ")}.`}</p>
      ) : null}
      {draft.sections.map((section, i) => (
        <div key={i} className="space-y-1">
          <label htmlFor={`${base}-${i}`} className="block text-sm font-semibold text-ink">{`Part ${i + 1}: ${section.title}`}</label>
          <textarea
            id={`${base}-${i}`}
            className="field"
            rows={8}
            maxLength={MAX_SECTION_CHARS}
            value={section.body}
            onChange={(event) => onEdit(i, event.target.value)}
          />
        </div>
      ))}
      <AiDraftReview checks={checks} onToggle={onToggle} topics={sensitiveTopics(texts.join("\n"))} estimates={unsourcedNumbers(draftStrings(draft.sections.map((s) => s.body)), given)} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary btn-sm inline-flex min-h-11 min-w-11 items-center justify-center" onClick={onSave} disabled={saving || !reviewDone([...checks])} aria-busy={saving}>
          {saving ? "Making the PDF…" : "Make the PDF and keep it as this product's file"}
        </button>
        <span className="text-xs text-ink-soft">{hold ?? "The product stays a draft. You publish it when you are ready."}</span>
      </div>
    </div>
  );
}

type Stage = "notes" | "outline" | "writing" | "review" | "saved";

export function AiFileAssist({ productId, onSaved }: { productId: string; onSaved: () => void }) {
  const ai = useContext(AiOn);
  const startKnown = allowanceOf(ai) !== null;
  const [stage, setStage] = useState<Stage>("notes");
  const [notes, setNotes] = useState("");
  const [outline, setOutline] = useState<FileOutline | null>(null);
  const [draft, setDraft] = useState<FileDraft | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [checks, setChecks] = useState<boolean[]>(freshChecks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [left, setLeft] = useState(ai.left);
  const [known, setKnown] = useState(startKnown);
  const [states, setStates] = useState<Partial<Record<AiStepId, StepView>>>({});
  const [announce, setAnnounce] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const run = useRef("");
  const startedAt = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const base = useId();

  useEffect(() => {
    if (stage !== "writing" || !busy) return;
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [stage, busy]);

  // Each new stage begins at its own heading, so a screen reader and a keyboard start where the new work is;
  // never when the page opens (focus moves only after the creator asked for something).
  useEffect(() => {
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [stage]);

  if (!ai.on) return null;

  const steps = outline ? fileSteps(outline.sections.map((s) => s.title)) : [];
  const jobs = outline ? fileJobs(outline.sections.length) : 0;

  async function post(body: Record<string, unknown>): Promise<Response> {
    return fetch("/api/store/ai-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product: productId, ...body }) });
  }

  async function plan() {
    if (busy) return;
    if (!notes.trim()) return setError(MESSAGES.notes);
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await post({ action: "outline", notes });
      const data = readAiAnswer(response.ok, await response.json().catch(() => null));
      const read = data.ok ? parseOutline(data.value) : null;
      if (data.ok && read) {
        setLeft(data.left);
        setKnown(true);
        setOutline(read);
        setStage("outline");
      } else {
        if (!data.ok && !Object.hasOwn(MESSAGES, data.error)) setKnown(false);
        setError(said(data.ok ? "unconfirmed" : data.error));
      }
    } catch {
      setKnown(false);
      setError(MESSAGES.unconfirmed);
    }
    setBusy(false);
  }

  function ended(line: AiStepLine | null, plan: FileOutline) {
    const ids = fileSteps(plan.sections.map((s) => s.title)).map((s) => s.id);
    setStates((now) => finalStates(ids, now));
    setAnnounce("");
    if (!line || !("done" in line)) {
      setKnown(false);
      return setError(MESSAGES.unconfirmed);
    }
    const value = line.ok ? line.value : "value" in line ? line.value : undefined;
    const got = value === undefined ? null : readFileDraft(value);
    if (line.ok || "returned" in line) {
      if (line.left === null) setKnown(false);
      else {
        setLeft(line.left);
        setKnown(true);
      }
    }
    if (got) {
      setDraft(got);
      setChecks(freshChecks());
      setMissing(plan.sections.map((s) => s.title).filter((title) => !got.sections.some((s) => s.title === title)));
      const back = !line.ok && "returned" in line ? (line.returned === null ? " We could not confirm the writing jobs given back: reload to check." : ` ${line.returned} writing job${line.returned === 1 ? "" : "s"} given back.`) : "";
      // The run's one save could not be confirmed: said now, before the creator reads and checks the parts.
      const unsure = "saveable" in line && line.saveable === false ? " We could not confirm that this text can be made into a file. Copy what you want to keep. If saving does not work, write the parts again." : "";
      setNote(`${line.ok ? "Written." : line.error === "stopped" ? "Stopped. The parts already written are below." : "Some parts could not be written. The parts that were are below."}${back}${unsure} Read each part, change what you want, then check the boxes.`);
      setStage("review");
      return;
    }
    if (!line.ok && "returned" in line) {
      const back = line.returned === null ? "We could not confirm the writing jobs given back: reload to check." : `${line.returned} writing job${line.returned === 1 ? "" : "s"} given back.`;
      return line.error === "stopped" ? setNote(`Stopped. Nothing was written. ${back}`) : setError(`The writing help could not finish just now. ${back}`);
    }
    if (!line.ok && !Object.hasOwn(MESSAGES, line.error)) setKnown(false);
    setError(said(line.ok ? "unconfirmed" : line.error));
  }

  async function write(plan: FileOutline) {
    if (busy) return;
    const steps = fileSteps(plan.sections.map((s) => s.title));
    const id = crypto.randomUUID().replace(/-/g, "");
    run.current = id;
    startedAt.current = Date.now();
    setElapsed(0);
    setStates({});
    setStopping(false);
    setError(null);
    setNote(null);
    setBusy(true);
    setStage("writing");
    let last: AiStepLine | null = null;
    try {
      const response = await post({ action: "sections", outline: plan, notes, run: id });
      if (!response.body || !(response.headers.get("content-type") ?? "").startsWith("application/x-ndjson")) {
        const data = readAiAnswer(response.ok, await response.json().catch(() => null));
        last = data.ok ? null : { done: true, ok: false, error: data.error };
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
          const lines = buffer.split("\n");
          buffer = chunk.done ? "" : (lines.pop() ?? "");
          for (const text of lines) {
            const line = text.trim() ? readStepLine(text) : null;
            if (line === null || line === "pad") continue;
            if ("done" in line) last = line;
            else {
              const index = steps.findIndex((s) => s.id === line.step);
              if (index < 0) continue;
              setStates((now) => ({ ...now, [line.step]: line.state === "started" ? "running" : "done" }));
              if (line.state === "started") setAnnounce(`Writing part ${index + 1} of ${steps.length}`);
            }
          }
          if (chunk.done) break;
        }
      }
    } catch {
      last = null;
    }
    setElapsed((Date.now() - startedAt.current) / 1000);
    setBusy(false);
    setStopping(false);
    ended(last, plan);
    if (!last || !("done" in last) || (!last.ok && !("value" in last))) setStage("outline");
  }

  async function stop() {
    if (stopping || !busy) return;
    setStopping(true);
    setAnnounce("Stopping after the parts already started.");
    try {
      const response = await fetch("/api/store/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "stop", run: run.current }) });
      const data = (await response.json().catch(() => null)) as { ok?: unknown } | null;
      if (response.ok && data?.ok === true) return;
    } catch {
      // Said below.
    }
    setStopping(false);
    setAnnounce("We could not stop it just now. You can press Stop again.");
  }

  async function save() {
    if (busy || !draft || !reviewDone(checks)) return;
    setBusy(true);
    setError(null);
    try {
      const sent = { title: draft.title, sections: draft.sections.map((s) => ({ title: s.title, body: cleanSectionBody(s.body) })).filter((s) => s.body) };
      const response = await post({ action: "save", run: run.current, draft: sent, checks });
      const data = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown; pages?: unknown } | null;
      if (response.ok && data?.ok === true) {
        setNote(`Done. The PDF${typeof data.pages === "number" ? ` (${data.pages} pages)` : ""} is now this product's file. The product is still a draft.`);
        setStage("saved");
        onSaved();
      } else setError(data?.error === "failed" ? SAVE_FAILED : said(typeof data?.error === "string" ? data.error : "unconfirmed"));
    } catch {
      setError(MESSAGES.unconfirmed);
    }
    setBusy(false);
  }

  const editPart = (i: number, change: Partial<FileOutline["sections"][number]>) =>
    setOutline((now) => (now ? { ...now, sections: now.sections.map((s, k) => (k === i ? { ...s, ...change } : s)) } : now));

  const allowance = known ? `${left} writing jobs left this month. Started attempts count, even if they fail.` : AI_ALLOWANCE_UNKNOWN;

  return (
    <details className="mt-3 rounded-2xl border border-violet-brand/25 bg-lilac/40 px-4 py-3">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold text-violet-deep">
        <Icon name="sparkle" size={16} />
        Write this product&apos;s file with AI
      </summary>
      <div className="mt-2 space-y-3 pb-1">
        <p className="text-sm text-ink-soft">
          You get a plan first and change it. Then each part is written, and you read and change the text. Only then is it made into a PDF and kept as this
          product&apos;s file, in your storage. The PDF has headings and paragraphs only: no lists, pictures or links. Nothing is published.
        </p>

        {stage === "notes" ? (
          <section className="space-y-2" aria-labelledby={`${base}-h`}>
            <h3 id={`${base}-h`} ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink">Step 1: Say what the guide is about</h3>
            <label className="block">
              <span className="block text-sm text-ink">What it teaches, and who it is for</span>
              <textarea className="field" rows={4} maxLength={MAX_AI_NOTES} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Example: easy weeknight dinners for busy parents, with a shopping list for each week." />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn btn-secondary btn-sm inline-flex min-h-11 min-w-11 items-center justify-center" onClick={() => void plan()} disabled={busy || !known || left <= 0} aria-busy={busy}>
                {busy ? "Planning…" : "Plan the guide (1 writing job)"}
              </button>
              <span className="text-xs text-ink-soft">{allowance}</span>
            </div>
          </section>
        ) : null}

        {stage === "outline" && outline ? (
          <section className="space-y-3" aria-labelledby={`${base}-h`}>
            <h3 id={`${base}-h`} ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink">Step 2: Check the plan</h3>
            <label className="block">
              <span className="block text-sm text-ink">Title of the guide</span>
              <input className="field" maxLength={MAX_FILE_TITLE} value={outline.title} onChange={(e) => setOutline({ ...outline, title: e.target.value })} />
            </label>
            <ol className="space-y-3">
              {outline.sections.map((section, i) => (
                <li key={i} className="space-y-1 rounded-xl bg-white p-3">
                  <label className="block">
                    <span className="block text-sm font-semibold text-ink">{`Part ${i + 1} name`}</span>
                    <input className="field" maxLength={MAX_SECTION_TITLE} value={section.title} onChange={(e) => editPart(i, { title: e.target.value })} />
                  </label>
                  <label className="block">
                    <span className="block text-sm text-ink">{`What part ${i + 1} covers, one point a line (up to ${SECTION_POINTS})`}</span>
                    <textarea
                      className="field"
                      rows={3}
                      maxLength={SECTION_POINTS * (MAX_SECTION_POINT + 1)}
                      value={section.points.join("\n")}
                      onChange={(e) => editPart(i, { points: e.target.value.split("\n").slice(0, SECTION_POINTS) })}
                    />
                  </label>
                  {outline.sections.length > 1 ? (
                    <button
                      type="button"
                      className="inline-flex min-h-11 min-w-11 items-center text-sm text-ink-soft underline underline-offset-4"
                      onClick={() => setOutline({ ...outline, sections: outline.sections.filter((_, k) => k !== i) })}
                    >
                      {`Remove part ${i + 1}`}
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
            {outline.sections.length < MAX_FILE_SECTIONS ? (
              <button type="button" className="btn btn-secondary btn-sm inline-flex min-h-11 min-w-11 items-center justify-center" onClick={() => setOutline({ ...outline, sections: [...outline.sections, { title: `Part ${outline.sections.length + 1}`, points: [] }] })}>
                Add a part
              </button>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-primary btn-sm inline-flex min-h-11 min-w-11 items-center justify-center"
                onClick={() => {
                  // Points are sent as written, one a line; empty lines and spaces at the ends are dropped first.
                  const clean = { ...outline, sections: outline.sections.map((s) => ({ title: s.title.trim(), points: s.points.map((p) => p.trim()).filter(Boolean) })) };
                  setOutline(clean);
                  void write(clean);
                }}
                disabled={busy || !known || left < jobs}
              >
                {`Write the guide (${jobs} writing jobs, about ${filePages(outline.sections.length)} pages)`}
              </button>
              <span className="text-xs text-ink-soft">{left < jobs && known ? `This plan needs ${jobs} writing jobs and ${left} are left. Remove some parts.` : allowance}</span>
            </div>
          </section>
        ) : null}

        {stage === "writing" ? (
          <section className="space-y-2" aria-labelledby={`${base}-h`}>
            <h3 id={`${base}-h`} ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink">Step 3: Writing the parts</h3>
            <AiStepsProgress
              steps={steps}
              states={states}
              announce={announce}
              elapsed={elapsed}
              canStop={busy && steps.some((s) => (states[s.id] ?? "waiting") === "waiting") && Object.keys(states).length > 0}
              stopping={stopping}
              onStop={() => void stop()}
            />
          </section>
        ) : null}

        {stage === "review" && draft ? (
          <section className="space-y-2" aria-labelledby={`${base}-h`}>
            <h3 id={`${base}-h`} ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink">Step 4: Read, change and check the text</h3>
            <AiFileReview
              draft={draft}
              given={`${notes}\n${outline ? JSON.stringify(outline) : ""}`}
              checks={checks}
              missing={missing}
              saving={busy}
              onToggle={(index, ticked) => setChecks((now) => now.map((c, k) => (k === index ? ticked : c)))}
              onEdit={(index, body) => {
                setDraft((now) => (now ? { ...now, sections: now.sections.map((s, k) => (k === index ? { ...s, body } : s)) } : now));
                // Changed text is read again before it is kept.
                setChecks(freshChecks());
              }}
              onSave={() => void save()}
            />
          </section>
        ) : null}

        {stage === "saved" ? (
          <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink">Step 5: Kept as this product&apos;s file</h3>
        ) : null}

        {error ? (
          <p className="notice notice-error text-sm" role="alert">
            {error}
          </p>
        ) : note ? (
          <p className="text-sm font-semibold text-ink" role="status">
            {note}
          </p>
        ) : null}
        <p className="text-xs text-ink-soft">
          It never invents reviews, numbers, results or deadlines. Read every part before you keep it: the file is yours, and you answer for what it says.
        </p>
      </div>
    </details>
  );
}
