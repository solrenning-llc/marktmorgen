# C2 independent review of #3028

Exact candidate: `acfda4b06489d8572a3f6d4654745dc4d282d6bf`.
Base: `c366e58ab40a1d9c9f4a42f60e62eb0ec1f67a92`.
Claim6697990425 preceded diff/source/tests. Channel reservationa8955300
preceded new evidence; resource refinementd93a8cae preceded all execution.
Author source, branch, PR head and CI remain unchanged.

## Verdict

No finding demonstrated in the complete seven-path delta. The local formatter
preserves known labels while explaining a retained selection that is absent
from the current form. It neither invents the historical label nor discloses
the retired ID. Truly absent answers retain `No answer.`. The shared formatter,
CSV, CRM, form definitions, persistence, admission and retention are unchanged.

The only production change is the helper and call in `lib/form-response-pdf.ts`.
`responseDrawable` and `responsePdf` consume the same `responseTexts`, so the
existing font-coverage check includes the new warning. Existing H2/P roles,
page breaking, tagging and headings remain unchanged. This is a narrow repair
of a false absence statement, not historical-label recovery or data recovery.

The review may clear this exact content, but it does not waive C4-3050 or the
integration hold. Normal merge still requires one qualified applicable opinion,
nine exact-final completed/success workflows, current clean integration and the
coordinator's release of the freeze. No CI green or deployment is inferred.

## Immutable RED and final replay

`9f86e473a81d0beb88cca32251c8a0f90ae4a123` differs from the candidate only in
the formatter and the author's report. The two permanent tests and original
proof are byte-identical. The runner verifies their Git blobs before execution
and substitutes only the exact old formatter bytes through esbuild's read-only
loader; it never writes the author's source. This reproduces the same executed
graph as the RED for the tested code; it is not a claim that the worktree HEAD
was moved to that commit.

| Execution | RED | Final |
| --- | --- | --- |
| Permanent historical-proof wrapper | 1 Node test fails, executing the original25 checks with2 failures | 1/1 Node test, original25/25 |
| Permanent formatter/PDF matrix | 13 Node tests,4 fail | 13/13 |
| Independent C2 pure controls | 12 cases,7 fail | 12/12 |
| Existing PDF importer | Not repeated on RED | 17/17 checks |

Do not add the nested25 audit checks to the14 Node tests as if independent test
roots. The independent12 cases cover order of mixed current/retired choices,
several/duplicate retired choices, duplicate current labels, a legacy scalar
in a multiple-choice field, frozen arrays, accented labels, numeric zero and
three genuine absence shapes. Each case also verifies unchanged raw response
bytes, untouched neighboring-question/consent paragraphs and H2/P roles. The
first pure run used an invalid nine-character form ID and failed its setup
control. Only that fixture ID was corrected before the valid replay; no assert
was relaxed and that run is not product evidence.

Reproduce from this evidence branch:

```
node proofs/c2/review-3028.mjs --red
node proofs/c2/review-3028.mjs
node proofs/c2/review-3028.mjs --pure --red
node proofs/c2/review-3028.mjs --pure
node proofs/c2/review-3028.mjs --linked
```

The two RED modes intentionally exit1. Candidate modes exit0. The original
proof, author assertions and all seven submitted files are unchanged here.
Only this report, the opt-in proof and explicit runner are new.

## Bounds and actual observations

Each test process has a120-second ceiling including bundling and a256KiB output
ceiling. Fetch is blocked before graph evaluation. The normal test aliases and
environment are reused. The Redis stand-in has an additional5,000-command
ceiling counted before every dispatched batch, including setup and inspection.
The original proof keeps its tighter4-scenario/40-command admission unchanged.
Observed original commands:27 on RED and27 final. Existing PDF importer:66.
Independent pure controls:0 storage commands and0 PDF generations.

Before running, the resource plan was expanded from2 to5 local PDF generations
because reading the existing importer revealed3 PDF generations in that linked
test. No PDF had been generated before the corrected reservation. Actual paired
matrix PDFs: RED17,354bytes/7pages, final18,807bytes/7pages. The existing17-check
importer additionally exercised its three normal PDF generations. Warnings are
asserted through the actual text formatter; no PDF text extraction, visual
inspection, human usability or PDF/UA certification is claimed. The three local
font files are unchanged and no font is downloaded.

No new productive IO, key, counter, supplier or price/limit/commission/flag/gate
is introduced by the candidate. CPU/output/hosting cost is not assumed zero;
the measured PDF-size delta is a fixture observation, not a monetary ceiling.
No real contact, account, provider, payment, native Redis or deployed journey
was exercised.

## Local quality gates

Directed TypeScript uses the real source tsconfig/import graph for four roots:
formatter, two new permanent tests and C2 proof. Zero diagnostics, exit0.
Lint and runner syntax are checked separately. One unused runner import was
removed after lint reported it; executable statements and assertions were not
changed, and test/PDF runs were not repeated for an import-only cleanup.
Final scanner/diff/tree receipts are recorded in the GitHub review after this
report is staged. Global TypeScript, browser suites and hosted CI are separate
and are not claimed here.
