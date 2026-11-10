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
