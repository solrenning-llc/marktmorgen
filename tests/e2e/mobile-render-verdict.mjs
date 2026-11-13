/**
 * Why one cold sample of tests/e2e/mobile-render.mjs fails, in words: the same rule the script applied in silence
 * (any blocked API write, an LCP, CLS or interaction that was not measured, and for the candidate build any target
 * missed: LCP under 2500 ms, CLS under 0.1, interaction to paint under 200 ms). An empty list passes.
 *
 * @param {{writes:number,lcp:unknown,cls:unknown,interactionMs:number|null,targets:{lcp:boolean,cls:boolean,interaction:boolean}}} sample
 * @param {string} label
 * @returns {string[]}
 */
export function sampleFailures(sample, label) {
  const reasons = [];
  if (sample.writes) reasons.push(`${sample.writes} blocked API writes`);
  if (!Number.isFinite(sample.lcp)) reasons.push("LCP not measured");
  if (!Number.isFinite(sample.cls)) reasons.push("CLS not measured");
  if (sample.interactionMs === null) reasons.push("interaction not measured");
  if (label === "candidate" && reasons.length === 0) {
    if (!sample.targets.lcp) reasons.push(`lcp target missed (${sample.lcp} ms, target under 2500 ms)`);
    if (!sample.targets.cls) reasons.push(`cls target missed (${sample.cls}, target under 0.1)`);
    if (!sample.targets.interaction) reasons.push(`interaction target missed (${sample.interactionMs} ms, target under 200 ms)`);
  }
  return reasons;
}
