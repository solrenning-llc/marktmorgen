# Reservations of Codex

Only Codex edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Codex | CX-20 recovery of original checkout-question capture and preintent integrity join; no producer or activation | codex/p1-checkout-question-origin (local) | `lib/checkout-question-candidate.ts`, `lib/checkout-question-origin-candidate.ts`, `tests/checkout-question-candidate.test.ts`, `tests/checkout-question-origin-candidate.test.ts`, `docs/order-email-question-origin.md` | 03/11/2026 |
