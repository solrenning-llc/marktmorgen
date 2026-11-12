/**
 * Every way a run of this workflow stops, in words, read from the workflow
 * itself and the engine's own limits (added 18 October 2026, ClickFunnels
 * audit row F23). The studio shows them beside the preview, before the
 * workflow is switched on.
 *
 * Each rule here is one the scheduled job enforces (lib/flows.ts,
 * sendDueSteps; lib/flow-retry.ts): nothing is listed that the code does not
 * do, and every stop the code makes is listed. A run also always ends after
 * its last step, because routes only go forward (lib/flow-paths.ts).
 *
 * Pure and browser-safe.
 */
import { MAX_RETRIES_BY_YOU, MAX_WAIT_DAYS_PER_STEP, MAX_WAITS_PER_RUN } from "@/lib/flow-limits";
import type { FlowGoal, StepCondition } from "@/lib/flow-rules";
import { END, type RoutedStep } from "@/lib/flow-paths";

export type StopRule = {
  /** What the rule is about: the workflow's own goal, conditions and ends, or the engine's. */
  kind: "goal" | "condition" | "end_after" | "last" | "left" | "paused" | "refused" | "waits" | "held" | "taken_out";
  /** The step it is at (0 for the first), when it is one step's. */
  step?: number;
  text: string;
};

export function stopRules(
  flow: { steps: readonly RoutedStep[]; goal?: FlowGoal | null },
  words: { condition: (when: StepCondition) => string; product: (id: string) => string },
): StopRule[] {
  const rules: StopRule[] = [];
  const goal = flow.goal;
  if (goal) {
    const what = "any" in goal ? "they buy anything" : "productId" in goal ? `they get ${words.product(goal.productId)}` : `they carry the label “${goal.tag}”`;
    rules.push({ kind: "goal", text: `The goal is reached: ${what}. It is checked before every step, so nothing after it is done.` });
  }
  flow.steps.forEach((step, i) => {
    if (step.when && step.otherwise === "end") rules.push({ kind: "condition", step: i, text: `At step ${i + 1}, ${words.condition(step.when)} does not hold: the run ends there.` });
    if (step.when && step.otherwise !== "end" && i === flow.steps.length - 1) rules.push({ kind: "condition", step: i, text: `At step ${i + 1}, the last, ${words.condition(step.when)} does not hold: nothing more is done.` });
    if (step.next === END && i < flow.steps.length - 1) rules.push({ kind: "end_after", step: i, text: `After step ${i + 1}: the run ends there, as that step says.` });
  });
  if (flow.steps.length) rules.push({ kind: "last", step: flow.steps.length - 1, text: `After the last step on their path. Routes only go forward, so a run never loops.` });
  rules.push(
    { kind: "left", text: "They leave your list: they unsubscribe, an email to them bounces, or they are removed." },
    { kind: "paused", text: "You pause the workflow, remove the step they are waiting at, or email stops being part of your plan." },
    { kind: "refused", text: "The sending service refuses an email as it is written." },
    { kind: "taken_out", text: "Another of your workflows reaches a step that takes them out of this one." },
    {
      kind: "waits",
      text: `A step that cannot go yet waits and is tried again by itself: when the month's emails turn, the next day, or after a growing delay. A run waits ${MAX_WAITS_PER_RUN} times at the most (a check while your store is switched off counts as half a wait), and one step ${MAX_WAIT_DAYS_PER_STEP} days; past that it stops, with nothing done at that step.`,
    },
    {
      kind: "held",
      text: `When a step's outcome cannot be confirmed, the run is held, not repeated, until you choose: it went through, try it again (up to ${MAX_RETRIES_BY_YOU} times a run), or end it.`,
    },
  );
  return rules;
}
