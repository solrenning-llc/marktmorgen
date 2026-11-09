"use client";

import { useContext, useEffect, useId, useRef, useState } from "react";
import { AI_ALLOWANCE_UNKNOWN, AiOn, allowanceOf } from "@/components/ai-assist";
import { Icon } from "@/components/icons";
import { MAX_AI_NOTES } from "@/lib/ai-rules";
import { readAiAnswer } from "@/lib/ai-response";
import { type AiStep, type AiStepId, type AiStepLine, readStepLine } from "@/lib/ai-steps";

/**
 * The writing help's box for a job told in named steps (758 [STN5] unit 1,
 * lib/ai-steps.ts): the same box as components/ai-assist.tsx, and while it
 * runs, each step with its state in words, the time since it began, and a
 * Stop button while a step is left that would then not be charged. It never
 * saves: the creator reads the draft and presses the page's own Save.
 *
 * Accessibility (AX274): only a change of step and the result are announced,
 * in a polite region; the clock is outside it, so a screen reader is not
 * talked over every second. Stop is a native button at least 44 by 44
 * pixels; once pressed it stays where it is and says it is stopping, and
 * once writing has started it stays too, unavailable and saying why, so
 * focus on it is never dropped mid-run. Nothing moves on the screen.
 *
 * A draft that comes back after the creator pressed Stop (writing had
 * already started, so it finished and counts) never replaces the page on
 * its own: the box says so and asks "Use this draft" or "Keep my page".
 */

export type StepView = "waiting" | "running" | "done" | "skipped";

const STATE_WORDS: Record<StepView, string> = {
  waiting: "Not started",
  running: "Running",
  done: "Done",
  skipped: "Not run, not charged",
};

const MESSAGES: Record<string, string> = {
  unconfirmed: "The writing result could not be confirmed. Review your current content and check your writing allowance before trying again.",
  notes: "Write a few words about it first: what it is, who it is for, what is inside.",
  used: "This month's writing help is used up. It starts again with your next billing month.",
  slow: "A few at a time: wait a minute, then try again.",
  failed: "The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance. Try again in a moment.",
  off: "The writing help is not available right now.",
  forbidden: "Your role on this store cannot do this.",
  file: "The product's PDF could not be read. Draft the page without it, or upload the PDF again.",
};
const REFUSED_BEFORE_START = new Set(["long", "invalid", "unknown"]);

/** Minutes and seconds since a job began, as the clock shows them. */
export function elapsedWords(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The steps of a running job, what is announced, the clock, and Stop. Drawn by AiStepsAssist; kept apart so it can be checked as drawn. */
export function AiStepsProgress({
  steps,
  states,
  announce,
  elapsed,
  canStop,
  stopShown = false,
  stopping,
  onStop,
  stopRef,
}: {
  steps: AiStep[];
  states: Partial<Record<AiStepId, StepView>>;
  announce: string;
  elapsed: number;
  /** Whether a step is left that a stop would leave uncharged. */
  canStop: boolean;
  /** Whether Stop stays drawn, unavailable, once writing has started, so focus on it is not dropped. */
  stopShown?: boolean;
  stopping: boolean;
  onStop: () => void;
  stopRef?: React.Ref<HTMLButtonElement>;
}) {
  const noteId = useId();
  return (
    <div className="space-y-2">
      <ol className="space-y-1 text-sm text-ink">
        {steps.map((step, i) => (
          <li key={step.id}>
            <span className="font-semibold">{`Step ${i + 1} of ${steps.length}: ${step.label}`}</span>
            <span className="text-ink-soft">{` (${STATE_WORDS[states[step.id] ?? "waiting"]})`}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm text-ink" role="status" aria-live="polite">{announce}</p>
      <p className="text-xs text-ink-soft">{`Elapsed: ${elapsedWords(elapsed)}`}</p>
      {canStop || stopShown ? (
        <div className="space-y-1">
          <button
            ref={stopRef}
            type="button"
            className="btn btn-secondary btn-sm inline-flex min-h-11 min-w-11 items-center justify-center"
            aria-disabled={stopping || !canStop}
            aria-describedby={noteId}
            onClick={() => {
              if (!stopping && canStop) onStop();
            }}
          >
            {stopping && canStop ? "Stopping after this step…" : "Stop"}
          </button>
          <p id={noteId} className="text-xs text-ink-soft">
            {canStop ? "The step already running still counts. Steps not started are not charged." : "Writing has started; it can no longer be stopped."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

const plural = (n: number) => `${n} writing job${n === 1 ? "" : "s"}`;

export function AiStepsAssist<T>({
  title,
  hint,
  placeholder,
  payload,
  steps,
  onResult,
  done,
  extra,
  allowEmpty = false,
  validateResult,
  messages,
}: {
  title: string;
  hint: string;
  placeholder: string;
  /** What is sent besides the notes, the steps and the run: the kind of job and what it needs. */
  payload: () => Record<string, unknown>;
  /** The steps this job will run, as lib/ai-steps.ts names them. */
  steps: AiStep[];
  onResult: (value: T) => void;
  done: string;
  extra?: React.ReactNode;
  allowEmpty?: boolean;
  validateResult?: (value: unknown) => value is T;
  /** This job's own words for an error, in place of the box's (e.g. "file", when its PDF could not be read). */
  messages?: Partial<Record<string, string>>;
}) {
  const ai = useContext(AiOn);
  const words: Record<string, string> = { ...MESSAGES };
  for (const [key, value] of Object.entries(messages ?? {})) if (typeof value === "string" && value) words[key] = value;
  const startKnown = allowanceOf(ai) !== null;
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [left, setLeft] = useState(ai.left);
  const [allowanceKnown, setAllowanceKnown] = useState(startKnown);
  const [readOnce, setReadOnce] = useState(startKnown);
  const [states, setStates] = useState<Partial<Record<AiStepId, StepView>>>({});
  const [announce, setAnnounce] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  // A draft that came back after Stop was pressed: kept here until the creator says whether to use it.
  const [late, setLate] = useState<{ value: T } | null>(null);
  const runRef = useRef("");
  const stopRequested = useRef(false);
  const focusResult = useRef(false);
  const startedAt = useRef(0);
  const stopRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const allowanceId = useId();

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  // Stop goes away when the job ends: focus that was on it moves to what was said, never to the top of the page.
  useEffect(() => {
    if (!focusResult.current || busy) return;
    focusResult.current = false;
    resultRef.current?.focus();
  }, [busy, error, said]);

  if (!ai.on) return null;

  const showSteps = busy || Object.keys(states).length > 0;
  const canStop = busy && steps.length > 1 && steps.some((s) => (states[s.id] ?? "waiting") === "waiting") && Object.keys(states).length > 0;
  // Once the job has started, Stop stays drawn until it ends, unavailable when nothing is left to stop.
  const stopShown = busy && steps.length > 1 && Object.keys(states).length > 0;

  function finish(message: { error?: string; said?: string }) {
    focusResult.current = stopRef.current !== null && document.activeElement === stopRef.current;
    setError(message.error ?? null);
    setSaid(message.said ?? null);
  }

  // Any step not done when the job ended was not run and not charged.
  function settleSteps() {
    setStates((now) => Object.fromEntries(steps.map((s) => [s.id, now[s.id] === "done" ? "done" : "skipped"])) as Partial<Record<AiStepId, StepView>>);
  }

  function ended(line: AiStepLine) {
    if (!("done" in line)) return;
    if (line.ok) {
      settleSteps();
      setAnnounce("");
      const unsure = line.returned === null;
      setLeft(line.left);
      setAllowanceKnown(!unsure);
      setReadOnce(true);
      if (validateResult && !validateResult(line.value)) {
        finish({ error: words.unconfirmed });
        return;
      }
      const given =
        line.returned === undefined
          ? ""
          : line.returned === null
            ? " A step that did not run is not charged; we could not confirm the writing jobs given back: reload to check your allowance."
            : ` A step that did not run is not charged: ${plural(line.returned)} given back, ${line.left} left this month.`;
      if (stopRequested.current) {
        // The creator asked to stop, but writing had already started: the draft is paid for, so it is kept, never put in the page unasked.
        setLate({ value: line.value as T });
        finish({
          said: `Writing had already started when you pressed Stop, so it finished and counts toward this month.${given} Your page is unchanged. Use this draft, or keep your page as it is?`,
        });
        return;
      }
      onResult(line.value as T);
      finish({ said: `${done}${given}` });
      return;
    }
    if ("returned" in line) {
      // A step that never reached the model, given back.
      settleSteps();
      setAnnounce("");
      const stopped = line.error === "stopped";
      const empty = line.error === "empty";
      const opening = empty
        ? "We found nothing to write from in your PDF's first pages, so the page was not written. Nothing was changed here. Add a few words about the product above, then try again."
        : "The writing help could not finish just now. Nothing was changed here.";
      if (line.returned === null || line.left === null) {
        setAllowanceKnown(false);
        const words = "We could not confirm the writing jobs given back: reload to check your allowance.";
        finish(stopped ? { said: `Stopped. Nothing was changed here. ${words}` } : { error: `${opening} ${words}` });
        return;
      }
      setLeft(line.left);
      setAllowanceKnown(true);
      setReadOnce(true);
      const back = `${plural(line.returned)} given back, ${line.left} left this month.`;
      finish(
        stopped
          ? { said: `Stopped. Nothing was changed here. The step that had started still counts; ${back}` }
          : empty
            ? { error: `${opening} The reading still counts; ${back}` }
            : { error: `${opening} A step that ran still counts; a step that did not run is not charged: ${back} Try again in a moment.` },
      );
      return;
    }
    const refused = REFUSED_BEFORE_START.has(line.error);
    if (!refused && !Object.hasOwn(words, line.error)) setAllowanceKnown(false);
    setAnnounce("");
    finish({ error: refused ? words.failed : Object.hasOwn(words, line.error) ? words[line.error] : words.unconfirmed });
  }

  function stepLine(line: AiStepLine) {
    if (!("step" in line)) return;
    const index = steps.findIndex((s) => s.id === line.step);
    if (index < 0) return;
    setStates((now) => ({ ...now, [line.step]: line.state === "started" ? "running" : "done" }));
    if (line.state !== "started") return;
    const step = `Step ${index + 1} of ${steps.length}: ${steps[index].label}`;
    // A step that starts after Stop was pressed: the stop came too late for it, and that is said at once.
    setAnnounce(stopRequested.current ? `Writing had already started when you pressed Stop, so it will finish and count toward this month. ${step}` : step);
  }

  /** The creator's answer about a draft that came back after Stop. */
  function choose(use: boolean) {
    if (!late) return;
    focusResult.current = true;
    if (use) onResult(late.value);
    setLate(null);
    setError(null);
    setSaid(use ? done : "Your page is as it was. The draft was not used; it still counts toward this month.");
  }

  async function run() {
    if (busy) return;
    if (!allowEmpty && !notes.trim()) {
      setError(words.notes);
      return;
    }
    const id = crypto.randomUUID().replace(/-/g, "");
    runRef.current = id;
    startedAt.current = Date.now();
    setElapsed(0);
    setStates({});
    setStopping(false);
    setLate(null);
    stopRequested.current = false;
    setAnnounce("");
    setError(null);
    setSaid(null);
    setBusy(true);
    let last: AiStepLine | null = null;
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload(), notes, steps: true, run: id }),
      });
      if (!response.body || !(response.headers.get("content-type") ?? "").startsWith("application/x-ndjson")) {
        // Refused before any step started: one answer, as the box without steps reads it.
        const data = readAiAnswer(response.ok, await response.json().catch(() => null));
        last = data.ok ? { done: true, ok: true, value: data.value, left: data.left } : { done: true, ok: false, error: data.error };
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
            if (!text.trim()) continue;
            const line = readStepLine(text);
            if (line === null || line === "pad") continue;
            if ("done" in line) last = line;
            else stepLine(line);
          }
          if (chunk.done) break;
        }
      }
    } catch {
      last = null;
    }
    setElapsed((Date.now() - startedAt.current) / 1000);
    if (last) ended(last);
    else {
      setAllowanceKnown(false);
      setAnnounce("");
      finish({ error: words.unconfirmed });
    }
    setStopping(false);
    setBusy(false);
  }

  async function stop() {
    if (stopping || !busy) return;
    stopRequested.current = true;
    setStopping(true);
    setAnnounce("Stopping after this step.");
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "stop", run: runRef.current }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: unknown } | null;
      if (response.ok && data?.ok === true) return;
    } catch {
      // Said below.
    }
    stopRequested.current = false;
    setStopping(false);
    setAnnounce("We could not stop it just now. The draft keeps going; you can press Stop again.");
  }

  return (
    <details className="rounded-2xl border border-violet-brand/25 bg-lilac/40 px-4 py-3">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold text-violet-deep">
        <Icon name="sparkle" size={16} />
        {title}
      </summary>
      <div className="mt-2 space-y-3 pb-1">
        <p className="text-sm text-ink-soft">{hint}</p>
        {extra}
        <label className="block">
          <span className="sr-only">What it should say</span>
          <textarea className="field" rows={4} maxLength={MAX_AI_NOTES} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={placeholder} />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void run()} disabled={busy || !allowanceKnown || left <= 0} aria-busy={busy} aria-describedby={allowanceId}>
            {busy ? "Writing…" : "Write a draft"}
          </button>
          <span id={allowanceId} className="text-xs text-ink-soft">
            {allowanceKnown ? `${left} left this month. Started attempts count, even if they fail.` : readOnce ? "Reload to check your writing allowance before trying again." : AI_ALLOWANCE_UNKNOWN}
          </span>
        </div>
        {showSteps ? (
          <AiStepsProgress
            steps={steps}
            states={states}
            announce={announce}
            elapsed={elapsed}
            canStop={canStop}
            stopShown={stopShown}
            stopping={stopping}
            onStop={() => void stop()}
            stopRef={stopRef}
          />
        ) : null}
        {error ? (
          <p ref={resultRef} tabIndex={-1} className="notice notice-error text-sm" role="alert">
            {error}
          </p>
        ) : said ? (
          <p ref={resultRef} tabIndex={-1} className="text-sm font-semibold text-ink" role="status">
            {said}
          </p>
        ) : null}
        {late ? (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary btn-sm inline-flex min-h-11 items-center justify-center" onClick={() => choose(true)}>
              Use this draft
            </button>
            <button type="button" className="btn btn-secondary btn-sm inline-flex min-h-11 items-center justify-center" onClick={() => choose(false)}>
              Keep my page
            </button>
          </div>
        ) : null}
        <p className="text-xs text-ink-soft">
          It uses only your own words, here and in your store, never invents reviews, numbers, results or deadlines, and saves nothing until you
          do. Read it before you publish: it is yours.
        </p>
      </div>
    </details>
  );
}
