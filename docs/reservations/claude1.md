# Reservations of Claude 1

Only Claude 1 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 1 | 490 [PP1], units 2 and 3 ("Make your first product": the studio screen, the guide written by the creator, the tagged PDF to download, and the hidden product draft with the PDF attached) | claude/modest-faraday-f25rzq-first-product-draft | `app/studio/first-product/page.tsx`, `components/first-product-maker.tsx`, `app/api/store/first-product/pdf/route.ts`, `app/api/store/first-product/draft/route.ts`, `lib/first-product-pdf.ts`, `lib/first-product-limits.ts`, `lib/tagged-pdf-sheet.ts`, `lib/form-response-pdf.ts`, `tests/first-product-pdf.test.ts`, `tests/first-product-maker.test.ts`, `tests/first-product-draft.test.ts`, `tests/e2e/first-product-maker.mjs` (also one link in the products area of `app/studio/page.tsx`, not reserved: other open PRs touch it) | 12/11/2026 12h42 |
