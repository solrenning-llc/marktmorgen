/**
 * The Codex audit of the money PRs merged without Codex (owner, OWNER-20261121-1944-C2-PRS-AFTER-AUDIT, PR 1).
 *
 * While Codex is out of use (until 25/11/2026 11h05 Fortaleza), OWNER-20261121-1437-CODEX-ABSENT-MONEY-REVIEW lets a
 * money PR merge with two money reviews from families outside its author instead of Codex's, on one condition: nothing
 * reaches a customer before Codex audits it. This record holds that audit, one line per PR, and
 * tests/codex-absent-audit.test.ts fails CI if OPENING_REQUESTED, PLANS_ON_SALE or ASSISTANT_ON_SALE is true while any
 * line is not done.
 *
 * The rules of the record (the owner's words, items 1 and 4 of PR 1):
 *   - every PR that used the exception has a line: the ones the owner named, and any other the coordinator finds
 *     citing the exception in PR comments and the owner confirms (item 1 of the decision). The test reads only this
 *     repository, so the list being complete depends on that reading, not on the test;
 *   - a line moves from "pendente" to done only in a PR reviewed by a family outside that PR's author, with the
 *     owner's confirmation of that line (an OWNER- identifier). No agent marks an audit done without it;
 *   - until Codex returns, a money PR may merge under the exception only if it already has a "pendente" line here
 *     before its queue request, with the two money reviews from families outside its author (item 2 of the decision).
 *
 * Nothing here changes a flag, a price, a limit, a tax, a ceiling or the Terms.
 */

export const CODEX_ABSENT_EXCEPTION = "OWNER-20261121-1437-CODEX-ABSENT-MONEY-REVIEW";

/**
 * The PRs the owner named in item 1 of OWNER-20261121-1944-C2-PRS-AFTER-AUDIT, then #5045 and #5048, which the owner
 * confirmed in item 1 of OWNER-20261122-0022-CODEX-LIST-VAT-COSTS (OWNER_CONFIRMED_LATER).
 */
export const OWNER_NAMED_PRS: readonly number[] = [5016, 5017, 5033, 5032, 5040, 4991, 5045, 5048];

/** The owner's confirmation of each PR added to the list after OWNER-20261121-1944. */
export const OWNER_CONFIRMED_LATER: Readonly<Record<number, string>> = {
  5045: "OWNER-20261122-0022-CODEX-LIST-VAT-COSTS",
  5048: "OWNER-20261122-0022-CODEX-LIST-VAT-COSTS",
};

/** The only results that make a line done (item 1 of PR 1), besides "pendente", which never does. */
export type CodexAuditResult = "pendente" | "feita, sem achado aberto" | `achados corrigidos nos PRs ${string}`;

export type CodexAuditLine = {
  /** The PR number. */
  pr: number;
  /** The head that was merged (40 hex characters), "fechado sem incorporar", or null while the PR is still open. */
  merged: string | null;
  /** The Codex reviewer who audited it (for example "Codex L"), or null while pending. */
  codexReviewer: string | null;
  /** Where Codex's report is kept, and the SHA-256 of its exact text, or null while pending. */
  report: { source: string; sha256: string } | null;
  /** The day of the audit (YYYY-MM-DD), or null while pending. */
  date: string | null;
  result: CodexAuditResult;
  /** The owner's confirmation of this line (OWNER-YYYYMMDD-HHMM-...), or null while pending. */
  ownerConfirmation: string | null;
};

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OWNER_ID = /^OWNER-\d{8}-\d{4}-[A-Z0-9][A-Z0-9-]*$/;
const FIXED_IN = /^achados corrigidos nos PRs #\d+(, #\d+)*$/;
const CLOSED = "fechado sem incorporar";

function realDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const at = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === day;
}

/** Whether a line is done: every field present and well formed, with the owner's confirmation. */
export function auditLineDone(line: CodexAuditLine): boolean {
  return (line.merged === CLOSED || (typeof line.merged === "string" && SHA.test(line.merged)))
    && typeof line.codexReviewer === "string" && /^Codex\b/.test(line.codexReviewer)
    && line.report !== null && line.report.source.trim() !== "" && SHA256.test(line.report.sha256)
    && typeof line.date === "string" && realDay(line.date)
    && (line.result === "feita, sem achado aberto" || FIXED_IN.test(line.result))
    && typeof line.ownerConfirmation === "string" && OWNER_ID.test(line.ownerConfirmation);
}

/** What is malformed in a line: a pending line holds no audit fields; a line not pending must be done. */
export function auditLineProblems(line: CodexAuditLine): string[] {
  const problems: string[] = [];
  if (!Number.isSafeInteger(line.pr) || line.pr <= 0) problems.push("the PR number is not a positive whole number");
  if (line.merged !== null && line.merged !== CLOSED && !SHA.test(line.merged)) problems.push("the merge head is not 40 hex characters");
  if (line.result === "pendente") {
    if (line.codexReviewer !== null || line.report !== null || line.date !== null || line.ownerConfirmation !== null) {
      problems.push("a pending line holds audit fields: either it is done, with every field, or it holds none");
    }
  } else if (!auditLineDone(line)) {
    problems.push("a line that is not pending must be done: merge head, Codex reviewer, report with SHA-256, date, result and the owner's confirmation");
  }
  return problems;
}

/**
 * What keeps opening closed: nothing while the owner has not asked to open and nothing is on sale; otherwise one
 * problem for each line not done. An owner's request that could not be read (null) counts as open.
 */
export function codexAuditOpeningProblems(
  state: { openingRequested: boolean | null; plansOnSale: boolean; assistantOnSale: boolean },
  lines: readonly CodexAuditLine[],
): string[] {
  if (state.openingRequested === false && !state.plansOnSale && !state.assistantOnSale) return [];
  return lines.filter((line) => !auditLineDone(line)).map((line) => `#${line.pr}: the Codex audit is not done with the owner's confirmation (${CODEX_ABSENT_EXCEPTION})`);
}

/**
 * The record. Every line is "pendente" today (owner, item 1 of PR 1): Codex is out of use until 25/11/2026. The merge
 * head of each merged PR is the head GitHub merged, read on 21/11/2026; #5017 is still open.
 */
export const CODEX_ABSENT_AUDIT: readonly CodexAuditLine[] = [
  { pr: 4991, merged: "07e2753c249a973261be258848c0ee3adfa222ad", codexReviewer: null, report: null, date: null, result: "pendente", ownerConfirmation: null },
  { pr: 5016, merged: "c6dcca69d8da5b39dbc53186e98ccd2cde696086", codexReviewer: null, report: null, date: null, result: "pendente", ownerConfirmation: null },
  { pr: 5017, merged: null, codexReviewer: null, report: null, date: null, result: "pendente", ownerConfirmation: null },
  { pr: 5032, merged: "99c32f89199ba567b60b2e93b57f6908fbf9377e", codexReviewer: null, report: null, date: null, result: "pendente", ownerConfirmation: null },
  { pr: 5033, merged: "878ebb25a33f8cb20f895caa1a97d0e9ae5e2df4", codexReviewer: null, report: null, date: null, result: "pendente", ownerConfirmation: null },
  { pr: 5040, merged: "d75b7405f2134e78c99bbd36716c12c270f997da", codexReviewer: null, report: null, date: null, result: "pendente", ownerConfirmation: null },
  // #5045 (the UK VAT rates per product) and #5048 (the VAT lines on the creator's statement): still open, added by
  // OWNER-20261122-0022-CODEX-LIST-VAT-COSTS, item 1, before their queue requests (item 2 of OWNER-20261121-1944).
  { pr: 5045, merged: null, codexReviewer: null, report: null, date: null, result: "pendente", ownerConfirmation: null },
  { pr: 5048, merged: null, codexReviewer: null, report: null, date: null, result: "pendente", ownerConfirmation: null },
];
