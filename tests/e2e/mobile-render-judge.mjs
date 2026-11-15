/**
 * How one cold sample of the mobile render lab is judged (tests/e2e/mobile-render.mjs). The bounds stay exactly as
 * strict on every sample: LCP under LCP_BOUND_MS, CLS under CLS_BOUND, interaction-to-paint under INTERACTION_BOUND_MS.
 * Decided by Claude 2 (coordinator), 13 November 2026, after five unrelated PRs failed on one slow sample each: a
 * sample whose only miss is interaction-to-paint is measured again, once, on the same page under the same throttling,
 * and passes only if that second measure is under the bound. LCP, CLS, a write or a measure that is missing are never
 * measured again. Every miss is returned with its page's value and bound, so the caller says it.
 */
export const LCP_BOUND_MS = 2500;
export const CLS_BOUND = 0.1;
export const INTERACTION_BOUND_MS = 200;

/**
 * "pass", "retry" (only interaction-to-paint missed, on the first attempt) or "fail", with the misses and, for a
 * failure the bounds did not cause, its reason. A baseline run is measured, never judged by the bounds; a write or a
 * missing measure fails any run.
 */
export function judgeSample(sample, attempt) {
  const { label, apiWrites, lcpMs, cls, interactionToPaintMs } = sample;
  if (apiWrites) return { verdict: "fail", misses: [], reason: `${apiWrites} write(s) during a measurement` };
  if (!Number.isFinite(lcpMs)) return { verdict: "fail", misses: [], reason: "no LCP measured" };
  if (!Number.isFinite(cls)) return { verdict: "fail", misses: [], reason: "no CLS measured" };
  if (interactionToPaintMs === null || !Number.isFinite(interactionToPaintMs)) return { verdict: "fail", misses: [], reason: "no interaction measured" };
  if (label !== "candidate") return { verdict: "pass", misses: [] };
  const misses = [];
  if (!(lcpMs < LCP_BOUND_MS)) misses.push({ target: "lcp", value: lcpMs, bound: LCP_BOUND_MS });
  if (!(cls < CLS_BOUND)) misses.push({ target: "cls", value: cls, bound: CLS_BOUND });
  if (!(interactionToPaintMs < INTERACTION_BOUND_MS)) misses.push({ target: "interaction", value: interactionToPaintMs, bound: INTERACTION_BOUND_MS });
  if (!misses.length) return { verdict: "pass", misses };
  if (attempt === 1 && misses.length === 1 && misses[0].target === "interaction") return { verdict: "retry", misses };
  return { verdict: "fail", misses };
}
