/**
 * The Codex audit of the money PRs merged without Codex, held in code before any sale (owner,
 * OWNER-20261121-1944-C2-PRS-AFTER-AUDIT, PR 1; the exception is OWNER-20261121-1437-CODEX-ABSENT-MONEY-REVIEW).
 *
 * While Codex is out of use (until 25/11/2026 11h05 Fortaleza), money PRs may merge with two money reviews from
 * families outside the author instead of Codex's, but nothing reaches a customer before Codex audits them. Until this
 * test, that condition was only text in docs/codex-queue.md: nothing kept OPENING_REQUESTED from turning true. What is
 * checked:
 *
 *   - the record (lib/codex-absent-audit.ts) holds one well-formed line per PR, with no PR twice, and every PR the owner
 *     named in item 1 of the decision;
 *   - a line counts as done only with a merge head of 40 hex characters (or "fechado sem incorporar"), a Codex
 *     reviewer, a report source with its SHA-256, a date, a result of "feita, sem achado aberto" or "achados
 *     corrigidos nos PRs #X", and the owner's confirmation of that line; anything else is pending;
 *   - OPENING_REQUESTED (read from the source of lib/opening.ts, where it is private), PLANS_ON_SALE and
 *     ASSISTANT_ON_SALE may be true only when every line is done; otherwise this test fails CI.
 *
 * What it cannot check: it reads only the repository's files. Whether the list is complete (every PR that used the
 * exception, as cited in PR comments) depends on the coordinator reading those comments and the owner confirming the
 * list (item 1 of the decision). Nothing here changes a flag, a price, a limit, a tax, a ceiling or the Terms.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSISTANT_ON_SALE, PLANS_ON_SALE } from "@/lib/opening";
import {
  CODEX_ABSENT_AUDIT,
  CODEX_ABSENT_EXCEPTION,
  OWNER_NAMED_PRS,
  auditLineProblems,
  auditLineDone,
  codexAuditOpeningProblems,
  type CodexAuditLine,
} from "@/lib/codex-absent-audit";
import { done, is, part } from "./check";

const source = readFileSync(join(process.cwd(), "lib/opening.ts"), "utf8");
const declared = source.match(/const OPENING_REQUESTED: boolean = (true|false);/g) ?? [];

part("The record names the exception and every PR the owner named");
is("the exception is OWNER-20261121-1437", CODEX_ABSENT_EXCEPTION, "OWNER-20261121-1437-CODEX-ABSENT-MONEY-REVIEW");
is("the owner's list in item 1 of OWNER-20261121-1944", [...OWNER_NAMED_PRS].sort((a, b) => a - b), [4991, 5016, 5017, 5032, 5033, 5040]);
is("every PR the owner named has a line", OWNER_NAMED_PRS.filter((pr) => !CODEX_ABSENT_AUDIT.some((line) => line.pr === pr)), []);
is("no PR has two lines", CODEX_ABSENT_AUDIT.length, new Set(CODEX_ABSENT_AUDIT.map((line) => line.pr)).size);
is("every line is well formed", CODEX_ABSENT_AUDIT.flatMap((line) => auditLineProblems(line).map((p) => `#${line.pr}: ${p}`)), []);

part("A line is done only with every field and the owner's confirmation");
const doneLine: CodexAuditLine = {
  pr: 1,
  merged: "a".repeat(40),
  codexReviewer: "Codex L",
  report: { source: "docs/codex-reports/L-20261126-0000-example.md", sha256: "b".repeat(64) },
  date: "2026-11-26",
  result: "feita, sem achado aberto",
  ownerConfirmation: "OWNER-20261126-1000-CODEX-AUDIT-5016",
};
is("a complete line is done", auditLineDone(doneLine), true);
is("and well formed", auditLineProblems(doneLine), []);
is("findings fixed in named PRs also count", auditLineDone({ ...doneLine, result: "achados corrigidos nos PRs #6001, #6002" }), true);
is("a closed PR not merged also counts", auditLineDone({ ...doneLine, merged: "fechado sem incorporar" }), true);
is("without the owner's confirmation it is not done", auditLineDone({ ...doneLine, ownerConfirmation: null }), false);
is("with an agent's identifier instead of the owner's it is not done", auditLineDone({ ...doneLine, ownerConfirmation: "C2-20261126-1000-AUDIT" }), false);
is("a pending result is not done", auditLineDone({ ...doneLine, result: "pendente" }), false);
is("a short merge head is not done", auditLineDone({ ...doneLine, merged: "a".repeat(10) }), false);
is("a PR still open (no merge head) is not done", auditLineDone({ ...doneLine, merged: null }), false);
is("a report without its SHA-256 is not done", auditLineDone({ ...doneLine, report: { source: doneLine.report!.source, sha256: "" } }), false);
is("a reviewer that is not Codex is not done", auditLineDone({ ...doneLine, codexReviewer: "Claude 5" }), false);
is("an impossible date is not done", auditLineDone({ ...doneLine, date: "2026-02-30" }), false);
is("a free-text result is not done", auditLineDone({ ...doneLine, result: "ok" as CodexAuditLine["result"] }), false);

part("Opening waits on every line");
const pending: CodexAuditLine = { pr: 2, merged: null, codexReviewer: null, report: null, date: null, result: "pendente", ownerConfirmation: null };
const closed = { openingRequested: false, plansOnSale: false, assistantOnSale: false };
is("closed, a pending line is allowed", codexAuditOpeningProblems(closed, [pending]), []);
is("the owner's request with a pending line fails", codexAuditOpeningProblems({ ...closed, openingRequested: true }, [pending]).length, 1);
is("plans on sale with a pending line fails", codexAuditOpeningProblems({ ...closed, plansOnSale: true }, [pending]).length, 1);
is("the assistant on sale with a pending line fails", codexAuditOpeningProblems({ ...closed, assistantOnSale: true }, [pending]).length, 1);
is("open with every line done passes", codexAuditOpeningProblems({ openingRequested: true, plansOnSale: true, assistantOnSale: true }, [doneLine]), []);
is("an unknown owner's request is treated as open", codexAuditOpeningProblems({ ...closed, openingRequested: null }, [pending]).length, 1);

part("The repository as it is");
is("OPENING_REQUESTED is declared once in lib/opening.ts", declared.length, 1);
const requested = declared.length === 1 ? /= true;/.test(declared[0]) : null;
is("nothing opens while a line is pending", codexAuditOpeningProblems({ openingRequested: requested, plansOnSale: PLANS_ON_SALE, assistantOnSale: ASSISTANT_ON_SALE }, CODEX_ABSENT_AUDIT), []);

done();
