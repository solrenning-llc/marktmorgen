# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 (nuvem Q) | AX274 Part A item 5: the emailed signed agreement copy reflows on a phone (WCAG 1.4.10) | claude4/ax-mail-agreement-viewport | `lib/agreements.ts`, `tests/ax-agreement-copy-viewport.test.ts` | 11/11/2026 15h48 |
| Claude 4 (nuvem Q) | AX274 Part A item 5: the emails and generated PDFs audit, recorded with its gaps | claude4/ax-mail-pdf-audit | `docs/accessibility-email-pdf-audit-2026-11-11.md` | 11/11/2026 15h46 |
| Claude 4 | r24-fresh-2 unit 3 (rule 24: a spent recovery link, rescue link or code whose read or session failed is not called expired, nor an error page) | claude4/r24-auth-unknown-status | `app/api/auth/lost/confirm/route.ts`, `app/api/auth/rescue/route.ts`, `app/api/auth/code/route.ts`, `tests/auth-unknown-status.test.ts` | 10/11/2026 01h39 |
| Claude 4 | Rule 24 sweep: the welcome offer counter is raised only on an exact "OK" (marks-exact-small) | claude4/marks-exact-small | `lib/welcome-offer-send.ts` (welcomeFor only), `tests/welcome-offer-count-exact.test.ts` | 08/11/2026 19h31 |
| Claude 4 | 274 [AX1] audit: the help center's answers at most 80 characters a line (1.4.8) | claude4/ax-help-line-length | `app/help/focus-scroll.css` (one rule at its end only), `app/help/buyers/page.tsx` (the answer paragraph's max-w only), `tests/help-line-length.test.ts` | 11/11/2026 15h44 |
| Claude 4 (nuvem 01S9eVA5BC) | 789 [IV1] unit 1 (A): EU/UK consumers refused on payment requests until the tax is collected (owner's decision IV) | claude4/eu-gate-pay-requests | `app/api/store/pay-request/route.ts`, `app/[handle]/pay/[request]/page.tsx`, `lib/buyer-words/requests.ts`, `lib/deemed-supplier-drafts.ts`, `tests/eu-vat-pay-request-gate.test.ts`, `tests/aliases/eu-vat-pay-request-gate.test.ts.json` | 19/11/2026 22h47 |
| Claude 4 (nuvem 01S9eVA5BC) | 789 [IV1] unit 1 (B): EU/UK consumers refused on store tips until the tax is collected; the support box as one form (owner's decision IV) | claude4/eu-gate-tips | `app/api/store/tip/route.ts`, `components/store-tip-box.tsx`, `lib/buyer-words/tips.ts`, `lib/deemed-supplier-drafts.ts`, `app/[handle]/page.tsx` (TIP_PROBLEMS only), `tests/eu-vat-tip-gate.test.ts`, `tests/aliases/eu-vat-tip-gate.test.ts.json` | 19/11/2026 23h20 |
