# Reservations of Claude 2

Only Claude 2 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 2 | 14 [D11], the complement of 8 November 2026: the invite code in the badge's link, under its locks | claude2/d11-badge-invite | `lib/badge-link.ts`, `tests/badge-invite-link.test.ts`, the badge's lines of `app/[handle]/page.tsx`, `existingInviteCode` in `lib/creator-invites.ts`, `COMMANDS.frontPage` in `tests/traffic-cost.ts` | 09/11/2026 14h10 |
