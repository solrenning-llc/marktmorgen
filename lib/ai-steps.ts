/**
 * A writing job told step by step (758 [STN5] unit 1, 9 November 2026): the
 * steps a job is made of, as the studio shows them while they run, and the
 * lines the server sends for them. Read by the browser too, so nothing here
 * talks to the model or the database (that is lib/ai.ts).
 *
 * A step is one call to the model. Its jobs are taken from the month before
 * the first step starts, all at once, so a later step never finds the month
 * spent after an earlier one was paid for. The creator may stop: a step
 * already sent to the model stays counted, because it may be billed; the
 * jobs of the steps that never started are given back, and no money is
 * reserved for them, because a call's money is reserved only right before it
 * is sent (lib/ai.ts, askModel).
 */
import { READ_PDF_JOBS, READ_PDF_PAGES } from "@/lib/ai-rules";

export type AiStepId = "read" | "write";
export type AiStep = { id: AiStepId; label: string; jobs: number };
export type AiStepState = "started" | "done";

/** The steps of a sales page drafted with AI: reading the product's own PDF first when the creator asked for it, then writing. */
export function pageSteps(pdf: boolean): AiStep[] {
  const write: AiStep = { id: "write", label: "Writing your page", jobs: 1 };
  return pdf ? [{ id: "read", label: `Reading the first ${READ_PDF_PAGES} pages of your PDF`, jobs: READ_PDF_JOBS }, write] : [write];
}

/** A run's id, made by the page that starts it: what a stop names. */
export const AI_RUN_ID = /^[A-Za-z0-9_-]{16,40}$/;

/** How long a stop's mark is kept: longer than two model calls at their timeout, and then it goes by itself. */
export const AI_STOP_KEEP_SECONDS = 300;

/**
 * Database commands a stepped page adds at the most, priced in the ai line
 * of tests/plan-cost-registry.ts for every writing job of the month: the
 * stop's mark read once between the two steps, written once by a stop, and
 * the jobs of the step not run given back once, and the run's own live mark
 * written once as it starts (a stop is written only over it: cloud I on
 * #3435, MEDIUM 1).
 */
export const AI_STOP_COMMANDS = 4;

/**
 * The first line of a stepped answer: some browsers hold a reply until its
 * first kilobyte has arrived, so without it the first step would not be
 * seen until it was over. Sent once a generation and priced as traffic.
 */
export const AI_STEP_PADDING_BYTES = 1_024;

/** Every byte a stepped answer adds to the draft's own at the most: the padding line, four step lines and the result's own fields. */
export const AI_STEP_EXTRA_BYTES = 1_536;

export type AiStepLine =
  | { step: AiStepId; state: AiStepState }
  // `returned`: the jobs of a step that never reached the model, given back while the draft still came (null when not confirmed).
  | { done: true; ok: true; value: unknown; left: number; returned?: number | null }
  // A step that never reached the model, given back: "stopped" when the creator asked, "empty" when the PDF gave nothing to write from, "failed" otherwise.
  | { done: true; ok: false; error: AiGivenBack; returned: number | null; left: number | null }
  | { done: true; ok: false; error: string };

/** Why a job told in steps ended with a step's jobs given back. */
export type AiGivenBack = "stopped" | "empty" | "failed";
const GIVEN_BACK: readonly unknown[] = ["stopped", "empty", "failed"] satisfies AiGivenBack[];

const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * One line of a stepped answer, read in its exact shape: a step, a result,
 * "pad" for the padding line, or null for anything else, which is never
 * taken for a step or a result.
 */
export function readStepLine(text: string): AiStepLine | "pad" | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const line = raw as Record<string, unknown>;
  const keys = Object.keys(line).sort().join(",");
  if (keys === "pad") return typeof line.pad === "string" ? "pad" : null;
  if (keys === "state,step") {
    return (line.step === "read" || line.step === "write") && (line.state === "started" || line.state === "done") ? { step: line.step, state: line.state } : null;
  }
  if (line.done !== true) return null;
  if (keys === "done,left,ok,value" && line.ok === true && count(line.left) && line.value !== undefined && line.value !== null) {
    return { done: true, ok: true, value: line.value, left: line.left as number };
  }
  if (keys === "done,left,ok,returned,value" && line.ok === true && count(line.left) && line.value !== undefined && line.value !== null) {
    const returned = line.returned === null ? null : count(line.returned) && (line.returned as number) > 0 ? (line.returned as number) : undefined;
    return returned === undefined ? null : { done: true, ok: true, value: line.value, left: line.left as number, returned };
  }
  if (keys === "done,error,left,ok,returned" && line.ok === false && GIVEN_BACK.includes(line.error)) {
    const known = count(line.returned) && (line.returned as number) > 0 && count(line.left);
    const unknown = line.returned === null && line.left === null;
    return known || unknown ? { done: true, ok: false, error: line.error as AiGivenBack, returned: line.returned as number | null, left: line.left as number | null } : null;
  }
  if (keys === "done,error,ok" && line.ok === false && typeof line.error === "string" && line.error && line.error !== "stopped" && line.error !== "empty") {
    return { done: true, ok: false, error: line.error };
  }
  return null;
}
