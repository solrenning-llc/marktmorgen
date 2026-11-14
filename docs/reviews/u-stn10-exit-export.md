# STN10 unit 3: offer the existing export while leaving

Base: `18e061644cd454ac67ad5f2813e6dec0a4c0e9af`.
Authorization: C1-20261109-2341-TODOS-84 and CODEXU-84.

An eligible creator opening the existing cancellation section now sees a link
to the existing main-data export card. The card explains exactly what its file
contains and what it excludes before the creator downloads it. The link is an
ordinary fragment, so following it sends no export request. Download still
requires the existing explicit form submission and its existing admission.

The link repeats the card's existing export permission, closing-state and
subscription-standing conditions. The fragment target accepts focus and has
a visible focus outline. Cancellation still submits the same single form;
export is optional and never a prerequisite for leaving.

## Permanent causal evidence

Public RED commit, created and read back before editing product:
`ebfe7b0da318981a18454289041d49ef008d9296`.
`proofs/u/stn10-20261109/current-main-red.json` preserves the exact raw output
and SHA-256: two failed cases and six passing controls. The permanent test reads
the current Studio source, finds the unique export card and cancellation section
with the TypeScript AST, and renders their exact enclosing JSX expressions with
React and synthetic props. It does not import or run StudioPage, authentication,
billing or a provider. A stale captured fixture cannot conceal a regression.

After the product change: eight cases pass, Redis 0, HTTP 0. Real networking is
denied before imports. Execution caps: 120 seconds wall time, 90 seconds CPU,
512 MiB Node heap, 256 KiB output, 100 mock HTTP calls and 20,000 synthetic Redis
dispatches; the last two counters are both zero in this graph.

The permanent test also passes strict TypeScript checking. The complete Studio
file passes TSX parsing; its ESLint run has zero errors and two pre-existing
unused-variable warnings (`STORAGE_BRAKE_BYTES`, `roomVisits`). Reservation and
diff-whitespace checks pass. Full application type checking, build and CI remain
pending; the selected test check is not a replacement for them.

## Scope and sibling inventory

The paid/trial cancellation section already accepts cancellation without a
required reason and displays the supplied end date. The existing ordinary export
and the closing-store export are separate; this change connects only the former.
The early paused/daily-plan exit, essential cancellation, renewal notices, billing
routes and the export route are unchanged. Those shared or sensitive scopes are
not inferred to be free from this narrow reservation.

STN10 units 1 and 2 (signup/cancel click parity, buyer consequences and contextual
optional-reason help) are not claimed as completed by this unit. Their existing
implementation and ownership require a separate scoped review.

Media-kit is already incorporated: #3044, merge
`4ff3f644535338ad12d0d090bcd2f169003309a1`, plus boundary tests #3170, merge
`6699310fc29fc4fcfed553fc5f17b8fdb38248d8`. The seven-language regression and
rule-30 sibling inventory already exist in main. No duplicate PR is opened.

## Acessibilidade

Cancellation remains two actions (open details, submit) and adds no mandatory
decision. Reaching export from the open exit gains one optional navigation;
downloading remains a separate explicit action. The link states its destination,
inherits existing ink colors, uses an underline and a 44 px minimum height.
The destination accepts focus without adding a Tab stop. No new animation,
time limit, required field, confirmation or automatic download is introduced.

Synthetic SSR checks cover permission/state guards, the link, its focusable target,
the end date, the unchanged cancellation intent and the single existing download
form. Browser focus transfer, screen readers, contrast measurements, reflow,
400% zoom and human usability have not been tested. No AAA, click-parity,
production availability or end-to-end cancellation certification is asserted.

## Cost and delivery state

This adds presentation only: no provider, Redis, fetch, prefetch or new export
operation. The existing export still bears its own accounted cost and ceiling.
CI and engineering costs are company costs, not assumed to be zero. No price,
limit, commission, payment behavior, policy, retention rule or flag changes.
State: tested locally; review, CI and incorporation remain pending.

## C4 review: export-scope wording

Review comment #6759243698 identified that the added invitation repeated
"your store's main data" without repeating its exclusions. The existing
`security-page.test.ts` exposed this at the exact reviewed head
`97c8b12dab4118639e596ade5a12aabebe25c6c9`: 41 checks, three failures.
The independent local reproduction is preserved before correction at
`solrenning-llc/repo-id-transfer-test@017c41e86aba1799bac7acd9bf7bed915fe7a4df`,
`evidence/cxu/stn10-m1-red-20261110.json` (raw log SHA-256
`a8bc7fcbd58b2ab19f0a5d5587ba0002920cd2e280253f9473968b2a078d0527`).

The invitation now asks the creator to review what is included and excluded,
then links to the existing explanation. It makes no additional export-scope
promise. The original card's full contents and exclusions, visibility rules,
fragment target and cancellation form remain unchanged. No test assertion or
expected count was relaxed.

After correction, all 41 security-page checks and all eight STN10 cases pass;
the three bounded runs together use Redis 0 and HTTP 0. GREEN security log
SHA-256: `4754e015a25cc4a6c16a1506f5ab2a7f6f1cd1653f6f1aba86da07599d0bc4ce`;
STN10 control log: `cd92247d523695bc18fb5abe4553f6c3e616ceef7eb9b47110bab884f116a715`.
ESLint still reports zero errors and the two pre-existing warnings above.
The public-data scanner reports 4,834 tracked files and zero corrections;
diff-whitespace checks pass. These checks cover the wording correction;
the remaining delivery and browser-testing gaps above still apply.
