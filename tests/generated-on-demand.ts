/**
 * The price, margin and cost reports that are generated on demand (owner, 20 November 2026, Fortaleza): no stored copy.
 *
 * Every pull request that changed a cost used to carry these reports, regenerated, and every entry into main put every
 * other cost pull request back in conflict on them. Since the owner's decision each one keeps its path with one short
 * fixed text that never changes, so it never conflicts and is never stale, and the report itself is computed by its
 * script from the current code whenever someone needs it. The tests that held a stored copy now hold the output
 * computed on demand, with the same checks. Input data and hand-written documents stay stored.
 */
export type OnDemandReport = { file: string; command: string; json: boolean };

/** In alphabetical order of the path (AGENTS.md AC (d)). */
export const ON_DEMAND_REPORTS: readonly OnDemandReport[] = [
  { file: "docs/feature-videos-cost.md", command: "node scripts/feature-videos-cost.mjs", json: false },
  { file: "docs/limits-proposal-2026-10-18.md", command: "node scripts/limits-proposal.mjs", json: false },
  { file: "docs/margin-alignment-2026-10-18.md", command: "node scripts/margin-alignment.mjs", json: false },
  { file: "docs/marktmorgen-affiliates.md", command: "node scripts/marktmorgen-affiliates.mjs", json: false },
  { file: "docs/pack-cost-decomposition-2026-10-18.md", command: "node scripts/pack-cost-decomposition.mjs", json: false },
  { file: "docs/per-use-resale-2026-10-18.md", command: "node scripts/per-use-resale.mjs", json: false },
  { file: "docs/pricing-optimization-2026-10-18.md", command: "node scripts/pricing-optimization.mjs", json: false },
  { file: "docs/pricing-optimization-milp-input-2026-10-18.json", command: "node scripts/pricing-optimization.mjs --milp-input", json: true },
  { file: "docs/pricing-optimization-milp-output-2026-10-18.json", command: "node scripts/pricing-optimization.mjs --milp-output", json: true },
  { file: "docs/pricing-usage-proposal-2026-10-18.md", command: "node scripts/pricing-usage-proposal.mjs", json: false },
];

/** The owner's sentence, with the report's own command. */
export const onDemandSentence = (command: string) =>
  `Generated on demand: run ${command}; the output is always computed from the current code.`;

/** What the stored file holds, exactly: the sentence, as JSON for a .json path so it stays a valid JSON file. */
export const onDemandText = (report: OnDemandReport) =>
  report.json ? `${JSON.stringify({ generatedOnDemand: onDemandSentence(report.command) }, null, 1)}\n` : `${onDemandSentence(report.command)}\n`;

export function onDemandReport(file: string): OnDemandReport {
  const found = ON_DEMAND_REPORTS.find((r) => r.file === file);
  if (!found) throw new Error(`${file} is not a report generated on demand`);
  return found;
}
